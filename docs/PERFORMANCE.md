# Performance: baseline vs expanded facility

Measured, not estimated. Browser numbers come from the production build (`vite preview`) in headless
Chrome on macOS with an **Intel UHD Graphics 630** (ANGLE/Metal), 1600x900 window, frame-rate limiting and
vsync disabled so frame time is the real CPU+GPU cost, not the 60 Hz cap. Each browser configuration was run
twice; ranges are shown. Node numbers are single-process `FactoryReplay` timings (mean of 5).
Treat absolute FPS as indicative only: a laptop on battery or a projector at a demo will differ.

## Optional overlay

Open the app with `?perf` (or press **P**) for FPS, frame time, draw calls, triangles, mesh count and events
processed per second. Disabled, it costs one boolean check per frame. `window.__ffPerf()` returns the latest
sample for scripted benchmarks.

## Results

| | Baseline | Expanded |
| --- | --- | --- |
| Factory objects (= modeled locations) | 11 | 19 |
| Workstations (3 ASM + 2 QC -> 6 ASM + 3 QC) | 5 | 9 |
| Building footprint | 56 x 32 m (1,792 m2) | 80 x 44 m (3,520 m2, 1.96x) |
| Customer orders / purchase orders (config) | 75 / 50 | 180 / 75 |
| Events generated | 1,834 | 4,073 |
| `events.json` | 917 KB | 2,061 KB |
| Meshes in scene | 68 | 101 |
| Draw calls | 80 | 121 |
| Triangles | 2,211 | 3,673 |
| FPS (median, uncapped, headless) | 271-280 | 196-223 |
| Frame time (median) | 3.6-3.7 ms | 4.6-5.1 ms |
| Events applied per second at 3600x | ~1.2 | ~7.2-7.8 |
| Events applied per second, peak at 86400x | ~92 | ~220 |
| Slider seek in browser (10-100% of timeline) | 2-13 ms | 7-30 ms |
| Full replay, Node | 22 ms | 53 ms |
| Seek to 50% / 100%, Node (incl. reset) | 7.6 / 17 ms | 18 / 39 ms |
| Dashboard KPI + station metrics, Node | 1.6 ms | 4.2 ms |

Observations:

- Cost scales roughly with object count (about +50%), not worse. Worst-case frame time during
  steady playback stayed under ~25 ms in both configurations.
- The worst single frames (280-840 ms) and long tasks (290-1,400 ms) occur once at load, when the JSON is
  parsed and the scene is built. Initial load is the only noticeable slowdown, and it is larger with the
  2x events file.
- No UI slowdown was observed while playing at 3600x or 86400x or dragging the progress slider.
- A full seek at 100% is under 40 ms even in Node; the dashboard refresh (250 ms interval) is ~4 ms.
- Draw calls are higher than meshes/2 because each station has up to 6 material groups plus a label
  sprite. If this ever matters, labels and shared-material parts are the first things to batch.

## Phase 0 baseline (domain core, Node)

Recorded 2026-10-15 for later comparison; deliberately **not** asserted in CI, because wall-clock timings are
flaky across machines. Node 22.22.3, Intel Core i9-9880H @ 2.30 GHz, macOS. Default dataset (seed
`northstar-2026`, 30 days, 4,073 events), mean of 5 runs after one warm-up, single process.

| Operation | Time |
| --- | --- |
| `generateDataset()` (includes reducer checks while generating) | ~311 ms |
| `validateDataset()` | ~150 ms |
| Full replay (`FactoryReplay.step()` over all events) | ~30 ms |
| Seek to 50% including reset | ~11 ms |
| Seek to 100% including reset | ~28 ms |
| `computeKpis` + station metrics, all-time window | ~4 ms |

Correctness baseline: `npm test` (72 tests, including `tests/contract.test.ts` on the committed canonical
fixture) and `npm run validate:data` must pass. Treat a >2x regression in any row above as worth
investigating. The browser results in the tables above predate this run and were not re-measured.

## Load-pipeline baseline (M0 of the source integration plan)

Recorded 2026-10-16 with `node scripts/bench-load.ts`; deliberately **not** asserted in CI. Same machine and Node as the
Phase 0 baseline (Node 22.22.3, i9-9880H), mean of 5 runs after one warm-up. Default dataset: seed `northstar-2026`,
schema 1.3.0, 4,651 events, `events.json` 2.51 MB. These are the figures the integration milestones (D7 budgets) are
measured against.

| Operation | Time |
| --- | --- |
| `JSON.parse(events.json)` (2.51 MB) | ~12 ms |
| `JSON.parse(initial_state.json)` | ~0.1 ms |
| `new FactoryReplay(initial, events)` (clones the initial state) | ~0.9 ms |
| Full replay (`FactoryReplay.step()` over all 4,651 events) | ~53 ms |
| Seek to 100% then back to start (two resets and one full replay) | ~43 ms |
| `structuredClone(final state)` (5,098 transactions, 223 orders, 1,088 operations) | ~23 ms |
| `JSON.stringify(final state)` (3.6 MB) | ~8-11 ms |
| Clone-per-event over the whole log, upper bound (final-size clone x 4,651) | ~106 s |

Notes:

- The full replay is ~53 ms for 4,651 events (the Phase 0 row of ~30 ms was for the 4,073-event dataset); per-event
  cost is about 11 us. Any reducer change is compared against this, with the 2x rule from the top of this document.
- The clone-per-event row is a ceiling (early states are smaller than the final one), but it is three orders of
  magnitude above the in-place replay. That is why section 7.6 of the plan rejects `applyEvent`-style cloning for replay
  and ingest, and keeps it only as a test oracle.
- Browser long tasks at load are unchanged by M0 (tests and docs only); the one-time parse cost above is a small part
  of the 290-1,400 ms observed at load, the rest being scene construction.

## Validation library cost (M1 of the source integration plan)

Measured 2026-10-16 with a Vite library build (`minify: true`, ES output) of the stated entry, then `gzip -9`. The app
bundle itself is unchanged by M1 (nothing in `src/` imports `src/sources` yet): `dist` JS is 709 kB, ~183 kB gzip.

| Entry | Raw | Gzip |
| --- | --- | --- |
| zod classic, one small schema (`import { z } from "zod"`) | 114 kB | 27.2 kB |
| zod classic, `src/sources` with `z` re-exported (namespace defeats tree-shaking) | 489 kB | 99.7 kB |
| **zod/mini**, the same small schema | 27.7 kB | 7.7 kB |
| **`src/sources` as shipped** (zod/mini + canonical JSON + identity + contracts) | 38.9 kB | 11.6 kB |

Decision D1 chose zod. Because the plan gates it on a measured budget, `src/sources` uses **`zod/mini`** (same engine
and error model, tree-shakable) and does not re-export the `z` namespace. M2's 22 event schemas will add to this; the
proposal is to re-measure after M2 and keep the whole sources layer under about 20 kB gzip. Node-side cost is
negligible (module load is a few ms; validation time is measured in M2 against the D7 load budget).

## Simulation as a source (M2 of the source integration plan)

Recorded 2026-10-16 with `node scripts/bench-load.ts` (same machine, Node and dataset as above; not asserted in CI).
The wire format is `src/sources/simulation/`; the app does not use it yet (M4), so these are the costs M4 will add.

| Operation | Time |
| --- | --- |
| `events.json` (domain) / wire events | 2.51 MB / 2.10 MB (0.84x; budget D7 is 1.5x) |
| Emit wire events at the generator edge | ~15 ms |
| `JSON.parse(wire events)` | ~10 ms |
| Adapt all 4,651 events (envelope check, payload decode with unit/status/timestamp conversion, content key) | ~125 ms |
| Adapt initial state and master data | < 1 ms |
| **Added one-time load work (parse + adapt)** | **~136 ms** (D7 budget: parse + validate + adapt + ingest about 300 ms) |

Bundle cost after M2 (Vite library build, minified, gzip -9): the adapter path (wire spec, codec, adapter, zod/mini
envelope check) is about 13.9 kB; the whole `src/sources` barrel including the emitter and identity is about 17.5 kB,
inside the proposed 20 kB budget. The emitter only runs at the generator edge and would not ship to the browser.

Where the adapt time goes (profiled): content key (canonical JSON about 40 ms, digest about 10 ms after replacing a
BigInt hash), payload decode about 23 ms, envelope validation about 60 ms. M3b adds ingest (sort plus one shadow replay,
about 30 to 50 ms), so the total is expected to stay under budget.

## Demand calibration

Baseline: 75 orders on 3 assembly stations gave 48-60% utilization (mean ~54%). Candidates on the 6-station
floor (utilization over the whole 30 days):

| Orders | ASM-001..006 | QC-001..003 | All checks |
| --- | --- | --- | --- |
| 75 | 37/35/29/24/20/18 | 21/11/8 | pass |
| 150 | 65/70/61/46/43/34 | 39/25/16 | pass |
| **180** | **76/66/67/54/57/55** | **43/29/21** | pass |
| 210 | 79/81/85/67/62/69 | 51/35/23 | pass |

180 was chosen: every assembly station is at 54-76% (mean ~62%, a bit above the baseline's 54% so the bigger
floor looks busy) and the demand surge still queues work. The dispatcher prefers the lowest free station id,
so ASM-001 is always the busiest and QC-003 the quietest.
