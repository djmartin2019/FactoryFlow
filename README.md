# FactoryFlow

**An interactive 3D manufacturing operations dashboard, driven by an event-sourced factory simulation.**

FactoryFlow renders a small electrical-panel factory in Three.js and wraps it in an operations dashboard:
live KPIs, a playback toolbar, a manufacturing activity feed, a workstation overview and a station
inspector. Everything on screen is derived from a stream of manufacturing events replayed onto a factory
state, so every number can be traced back to the events that produced it.

> **Demo Mode — Synthetic Manufacturing Data.**
> The simulation exists to provide realistic demonstration data. The long-term goal is to replace the
> synthetic event stream with real data from ERP, MES, inventory and analytics systems; the dashboard
> and domain layers do not care where events come from.

---

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
  - [Architecture at a glance](#architecture-at-a-glance)
  - [The event-sourced model](#the-event-sourced-model)
  - [The simulation clock](#the-simulation-clock)
  - [Dashboard data flow](#dashboard-data-flow)
  - [3D scene and interaction](#3d-scene-and-interaction)
  - [Station status colouring vs. highlighting](#station-status-colouring-vs-highlighting)
- [KPI definitions](#kpi-definitions)
- [The synthetic company and dataset](#the-synthetic-company-and-dataset)
- [Project structure](#project-structure)
- [Scripts](#scripts)
- [Testing](#testing)
- [Design constraints](#design-constraints)
- [Connecting real data](#connecting-real-data)
- [Known limitations](#known-limitations)

---

## Features

| Area | What you get |
| --- | --- |
| **3D factory** | Interactive Three.js facility (80 × 44 m) with receiving, raw-material racks, assembly cells, QC cells and shipping bays. Orbit, pan and zoom; hover and click to select. |
| **KPI cards** | Six metrics computed from real state: good units, WIP, active orders, utilization, first-pass yield, shortage-blocked orders. Hover a card for its exact definition. |
| **Playback toolbar** | Play/pause, reset, 60× / 600× / 3600× / 86400× speed, simulated date-time and a scrubbable progress bar. |
| **Activity feed** | Latest 20 manufacturing events with timestamp, readable description, event type and station. Click an entry to select the related station in 3D. |
| **Workstation overview** | Compact table of station, status, current work order, queue and utilization. Click a row to focus the 3D station. |
| **Station details** | Status, current order, product, queue, utilization and recent events for workstations; stock on hand and reservations for inventory locations. |
| **Performance overlay** | Optional FPS / frame time / draw calls / triangles / events-per-second HUD: open with `?perf` or press `P`. See [docs/PERFORMANCE.md](docs/PERFORMANCE.md). |
| **Responsive layout** | The 3D view stays the main focus; the sidebar stacks below it on narrow screens. |

## Quick start

Requires Node.js 22+ and npm.

```bash
npm install
npm run dev          # start the Vite dev server
```

Open the URL Vite prints. The simulation starts playing at 3600× (one simulated hour per real second).

```bash
npm run build        # typecheck + production build into dist/
npm run preview      # serve the production build
npm test             # run the Vitest suite
```

The generated dataset is served from `public/data/` (a symlink to `data/generated/`). To regenerate it:

```bash
npm run generate:data                       # default seed "northstar-2026", 30 days
npm run generate:data -- --seed=abc --days=45 --customerOrders=120
npm run validate:data                       # re-validate on disk and prove determinism
```

## How it works

### Architecture at a glance

```
          ┌──────────────────────────── src/manufacturing  (pure TS, no DOM / Three.js) ───────────────┐
          │  generator ─▶ events.json + initial_state.json      state.ts (reducer + business rules)     │
          │  replay.ts (FactoryReplay)   selectors.ts   mapping.ts   dashboardMetrics.ts   eventFormat.ts│
          └──────────────────────────────────────────▲──────────────────────────────────────────────────┘
                                                     │ reads state / master data
 public/data/*.json ─▶ loadSimulationData ─▶ SimulationController  (the ONE simulation clock)
                                                     │
                      ┌──────────────────────────────┴─────────────────────────────┐
                      ▼                                                            ▼
         src/graphics  (Three.js)                                       src/ui  (vanilla DOM)
   SceneManager ▸ Factory ▸ FactoryVisualizer ▸ InteractionManager      Dashboard ▸ KpiCards, PlaybackToolbar,
   animation loop calls simulation.update(dt)                           ActivityFeed, StationOverview, StationDetails
```

Three layers with strict dependency direction:

1. **`src/manufacturing/`** – domain code. No Three.js, no DOM, no timers. Contains the state reducer, the
   replay engine, read-model selectors, KPI calculations and event-to-text formatting.
2. **`src/simulation/`** – `SimulationController`, the single simulated clock wrapping `FactoryReplay`.
3. **`src/graphics/` and `src/ui/`** – presentation. They read state and call controller methods; they
   never mutate manufacturing state themselves.

### The event-sourced model

The dataset is two files:

- `initial_state.json` – master data (products, BOMs, routings, suppliers, customers, locations,
  workstations) plus opening balances.
- `events.json` – an ordered log of ~4,000 events (`PURCHASE_ORDER_CREATED`, `MATERIAL_RECEIVED`,
  `PRODUCTION_ORDER_RELEASED`, `OPERATION_STARTED`, `QUALITY_INSPECTION_COMPLETED`,
  `SHIPMENT_DISPATCHED`, `MACHINE_FAILED`, …).

`FactoryState` is *only* ever produced by applying events, in sequence, to the initial state. All business
rules live in one reducer (`state.ts`, `applyEventInPlace`); invalid transitions throw an
`InvariantViolation`. Inventory is tracked as `onHand`, `reserved` and `available = onHand − reserved`
with the invariant `0 ≤ reserved ≤ onHand` enforced on every move.

Important consequences:

- **Anything can be re-derived.** Seeking or resetting just replays the log from the start.
- **Material becomes WIP at a defined moment** (`MATERIAL_CONSUMED`) and leaves WIP only through
  finished-goods receipt or scrap, so WIP is conservation-checked.
- **Events are traceable.** Each event carries `entities` (order, workstation, material, location IDs), which
  drives both the activity feed and 3D highlighting.

Details of the data model, event semantics and variability sources (supplier delays, material shortages,
machine downtime, quality failures, demand surge) are in
[`src/manufacturing/README.md`](src/manufacturing/README.md).

### The simulation clock

`SimulationController` owns the **one authoritative simulated timestamp** (`currentTime`). Each animation
frame, `SceneManager` calls `simulation.update(deltaSeconds)`:

```
currentTimeMs += deltaSeconds * 1000 * speed
replay.advanceToMs(currentTimeMs)        // applies every event with timestamp <= currentTimeMs
```

It also exposes `progress`, `startTime`, `endTime`, `speedMultiplier`, `seekTo()`, `reset()` and an
`epoch` counter. `epoch` increments whenever history is discarded (reset or seek) so consumers such as the
activity log drop cached events instead of showing stale data. The dashboard does not create any second
clock; it reads this one.

### Dashboard data flow

The dashboard refreshes on its own 250 ms timer, independent of the render loop, and skips refreshes while
the tab is hidden:

```
SimulationController ──state/time──▶ Dashboard.refresh()
                                       ├─ periodWindow(period, currentTime)
                                       ├─ stationMetrics(state, master, window)   → StationOverview, StationDetails
                                       ├─ computeKpis(state, master, window)      → KpiCards
                                       ├─ PlaybackToolbar.update()
                                       └─ ActivityFeed.update()                   (only if the log changed)

FactoryReplay.onEvent ──▶ describeEvent() ──▶ ActivityLog (ring buffer, 200 entries)
```

Bounded by design:

- The activity log is a fixed-capacity ring (200 entries); the feed renders at most 20 rows.
- Components update text nodes in place and only touch the DOM when a value changed.
- At 86400× playback the DOM stays at a few hundred nodes.

### 3D scene and interaction

- `Factory` builds the facility from `src/data/factoryLayout.ts`: building shell, department zones, floor
  markings, labelled stations. Layout object IDs (`REC-001`, `INV-001`, `ASM-001`, `QC-001`, `SHP-001`, …)
  are identical to manufacturing location and workstation IDs, so mapping is identity.
- `FactoryVisualizer` translates state into colours whenever a new event was applied: workstations by
  operational status, storage racks by pallet fill level.
- `InteractionManager` handles hover and click raycasting. `SceneManager.select(id)` selects a station
  programmatically through the same path as a canvas click, which is how table rows and feed entries focus
  stations.
- `mapping.ts` (`factoryObjectsForEvent`, `factoryObjectsForEntity`, `recordsForFactoryObject`) answers
  "which meshes does this event or record belong to?" without any rendering code.

### Station status colouring vs. highlighting

| Colour | Meaning |
| --- | --- |
| Grey | Idle |
| Green | Running |
| Amber | Blocked (idle assembly cell while orders wait on material) |
| Red | Machine down |

Hover (white) and selection (yellow) are *overlays*. `InteractionManager` marks the mesh with a
`highlightColor`; when `FactoryVisualizer` recolours a station for a status change it keeps the overlay
and updates the underlying base colour, so selection and status never overwrite each other. Selected-station
status is always readable in the overview table and details panel.

## KPI definitions

Computed in `src/manufacturing/dashboardMetrics.ts` from `FactoryState` at the simulated timestamp. Nothing
is hardcoded or random. A header selector sets the measurement period for historical KPIs: **Last 24 h**
(default), **Last 7 d**, or **Since start**. The window is `(max(simStart, now − period), now]`.

| KPI | Kind | Definition |
| --- | --- | --- |
| Good units produced | Historical | Σ `finishedGoodsReceivedQuantity` of production orders whose `completedAt` falls in the window |
| Work in progress | Current | Σ `wipQuantity` over all production orders |
| Active production orders | Current | Orders with status `WAITING`, `RUNNING` or `BLOCKED` |
| Workstation utilization | Historical | Σ per-station busy minutes ÷ (stations × scheduled shift minutes); shifts are Mon–Fri 06:00–18:00 UTC; machine-downtime overlap excluded; per-station busy time capped at the shift time |
| First-pass quality yield | Historical | Σ `passedQuantity` ÷ Σ `inspectedQuantity` over round-1 inspections with `inspectedAt` in the window |
| Shortage-blocked orders | Current | Orders with status `BLOCKED` and `blockReason = MATERIAL_SHORTAGE` |

Utilization and first-pass yield display **N/A** when their denominator is zero (no shift time elapsed, or
no round-1 inspection in the window). Full definitions, sources and limitations:
[`docs/KPI_DEFINITIONS.md`](docs/KPI_DEFINITIONS.md).

## The synthetic company and dataset

The fictional **Northstar Components** assembles three control panels:

| Product | Routing |
| --- | --- |
| NCP-100 Basic | Mount & wire → Final test |
| NCP-200 Motor | Mount & wire → Motor circuit assembly → Final test |
| NCP-300 Advanced Automation | Mount & wire → PLC/HMI integration → Final test |

Thirteen raw materials come from five suppliers; ten customers place orders. Defaults: seed
`northstar-2026`, start 2026-09-01, 30 days, 180 customer orders, a demand surge on days 12–16, and two
machine failures per assembly station. The facility has 6 assembly stations, 3 inspection cells, 4 raw-material
racks, 3 receiving docks and 3 shipping bays; `npm run generate:data -- --assemblyWorkstations=3
--inspectionWorkstations=2 --customerOrders=75` reproduces the original smaller operation on the same floor.

Generation is **deterministic**: the same seed and config always produce the same event log (verified by an
event-log hash in `manifest.json`). The generator proposes events through the same reducer the app uses, so
generated data cannot violate business rules.

## Project structure

```
src/
  main.ts                    Entry: load data → controller → dashboard → scene
  style.css                  Dashboard + station panel styles
  data/                      3D layout (factoryLayout.ts, layoutTypes.ts)
  manufacturing/             Domain model — no DOM / Three.js
    types.ts                   Interfaces, event payloads
    state.ts                   Reducer + all business rules
    generator.ts, rng.ts       Deterministic dataset generation
    replay.ts                  FactoryReplay (event cursor, seek, reset)
    selectors.ts, mapping.ts   Read models; entity ↔ 3D object mapping
    dashboardMetrics.ts        KPI + station metrics
    eventFormat.ts             Event descriptions + bounded ActivityLog
  simulation/                SimulationController (single clock), data loading
  graphics/                  Three.js: SceneManager, Factory, FactoryVisualizer,
                             InteractionManager, CameraController, stations, labels
  ui/                        Vanilla DOM components: Dashboard, KpiCards,
                             PlaybackToolbar, ActivityFeed, StationOverview, StationDetails
tests/                       Vitest suites
scripts/                     generate.ts, validate.ts
examples/                    replay-example.ts
docs/KPI_DEFINITIONS.md      KPI documentation
public/data → data/generated Dataset served to the browser
```

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | `tsc` + production build |
| `npm run preview` | Serve the production build |
| `npm test` | Vitest suite |
| `npm run typecheck` | Typecheck scripts, tests and domain code |
| `npm run typecheck:app` | Typecheck the app (`tsc --noEmit`) |
| `npm run generate:data` | Generate, self-validate and write the dataset |
| `npm run validate:data` | Re-validate on-disk data and confirm determinism |
| `npm run example:replay` | Print dashboard-style views from a replay |

## Testing

`npm test` covers:

- Dataset generation determinism, validation invariants and reducer rules.
- Layout and 3D object construction.
- KPI correctness against independent sums over the final state and event log.
- Reset restoring initial KPI values; pause freezing state; seek bumping the epoch; end-of-dataset stop.
- Activity log boundedness and clearing; every event type producing a readable description.

## Design constraints

- Vanilla TypeScript and CSS — no React or UI framework.
- Domain code stays independent of Three.js and the DOM.
- The event-sourced replay architecture is preserved; no second simulation clock.
- No backend. Data is static JSON served by Vite.
- No material-movement animations yet (the `flows` mapping from `factoryObjectsForEvent` is ready for them).

## Connecting real data

The seam is the event stream. To drive FactoryFlow from real systems:

1. Map ERP/MES/inventory records to the event types and payloads in `src/manufacturing/types.ts`, using
   location and workstation IDs that match `src/data/factoryLayout.ts` (or extend the layout).
2. Provide an `InitialStateFile` (master data + opening balances) and an ordered event log.
3. Feed events to `FactoryReplay`; for live data, append events and call `advanceTo` as they arrive.

The reducer's invariants then act as a data-quality check on the incoming stream.

## Known limitations

- Selecting from the feed highlights only the primary related station or location, not every related object.
- Per-station queue length follows the existing selector: assembly stations share one global waiting queue;
  inspection stations show orders awaiting QC.
- Good units are attributed to finished-goods receipt time rather than build time.
- Utilization counts run time after shift end against the shift, capped at 100% per station.
- The progress bar ends at the last event timestamp; the dataset is a fixed 30-day synthetic run.
- The production bundle is ~650 kB (mostly Three.js) and is not code-split.
- Layout is verified at desktop widths; narrow-screen breakpoints exist but are lightly tested.
