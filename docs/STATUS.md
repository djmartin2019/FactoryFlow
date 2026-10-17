# Implemented versus proposed

`docs/FACTORYFLOW_DESIGN.md` describes where FactoryFlow is going. This file records what exists in the
repository **today**, as of the Phase 1 equipment and changeover slice (2026-10-16). If the two disagree, the code and this file are
the current truth; the design doc is intent.

Legend: **Implemented** works and is tested or validated. **Partial** exists in reduced form. **Proposed**
does not exist; do not assume it.

## Data and domain

| Capability | Status | Where / note |
| --- | --- | --- |
| Event-sourced domain core, no UI or 3D dependency | Implemented | `src/manufacturing/` |
| Typed master data, state, 22 event types | Implemented | `types.ts`; schema `1.0.0` |
| Seeded, deterministic event generator | Implemented | `generator.ts`; hash in `manifest.json` |
| Reducer business rules and invariants | Implemented | `state.ts` (`InvariantViolation`) |
| Dataset validation and determinism check | Implemented | `validation.ts`, `npm run validate:data` |
| Separate routings for NCP-100 / 200 / 300 | Implemented | `masterData.ts` |
| Quality inspection, rework, machine downtime | Implemented | events + reducer |
| Supplier purchase orders and receipts | Implemented | `PURCHASE_ORDER_CREATED`, `MATERIAL_RECEIVED` |
| Shortage blocking with KPI | Implemented | `PRODUCTION_BLOCKED`, `shortageBlocked` KPI |
| Reservations distinct from consumption | Partial | `MaterialReservation` and `MATERIAL_CONSUMED` are separate records; roadmap Phase 3 lists the full distinction as remaining |
| Per-product routings: NCP-100 (kit, mount, wire, test), NCP-200 (+ motor-control setup), NCP-300 (+ PLC/HMI configure) | Implemented | schema 1.1.0; `disposition` is not a separate operation, it is the round-1/2 inspection outcome shown in the work-order timeline |
| Work centers distinct from physical workstations | Implemented | `WorkCenter` master data; stations declare `workCenterIds` (`assemblyLanes`); dispatch is per operation so orders hop between stations (schema 1.2.0) |
| Work-center queues and bottleneck candidate | Implemented | `analytics/workCenters.ts`, Explorer "Work Centers" tab; definitions in `KPI_DEFINITIONS.md` |
| Sequence-dependent setup (changeover) times | Implemented | schema 1.3.0; `changeovers` table per work center and from→to product, history kept per station and work center (`rules.ts`); synthetic values, rework exempt |
| Equipment requirements on operations | Implemented | schema 1.3.0; pooled `equipment` units, `RoutingStep.requiredEquipment` kinds, held start→completion; equipment does not fail or have calendars yet (Phase 4) |
| Skill requirements and qualified-staff constraints | Proposed | **Phase 4** (needs the workforce model; removed from Phase 1) |
| Serialized manufactured units and per-attempt history | Proposed | Phase 2 |
| BOM and routing revision captured on work orders | Proposed | Phase 2 |
| Incoming quality hold, partial receipts, substitutes | Proposed | Phase 3 |
| Workforce, shifts, finite-capacity scheduling | Proposed | Phase 4 |
| Scenario comparison, forecasts, planning outputs | Proposed | Phase 5, design §11 |
| Source adapter, provenance, freshness, capability flags | Partial | `src/sources/`: contracts (`types.ts`), canonical JSON, identity, and the simulation as a source (`simulation/`: wire format, emitter, adapter; round trip is exact, hashes unchanged). Not wired into the app: the app still loads domain JSON directly (plan M4). No ingest, ordering or quarantine yet (M3b); design §6.2, §12 |
| Runtime validation of external input shape | Partial | `src/sources/validation.ts` (zod/mini primitives, never throw, `MappingIssue` output) with negative tests; no adapter or app path uses it yet (M2) |
| Database, message broker, authentication, backend | Proposed | deliberately absent; persistence is in memory |
| Analytics warehouse / star schema | Proposed | design §10; reporting is computed from state and events |

## Analytics and UI

| Capability | Status | Where / note |
| --- | --- | --- |
| Six KPIs with documented definitions and drill-down numerators | Implemented | `dashboardMetrics.ts`, `docs/KPI_DEFINITIONS.md` |
| Station metrics and overview / details | Implemented | `StationOverview`, `StationDetails` |
| Activity feed (bounded) | Implemented | `eventFormat.ts`, `ActivityFeed` |
| Work-order list and detail drawer (timeline, routing, materials) | Implemented | `analytics/workOrders.ts`, `ui/explorer` |
| Good-units throughput chart | Implemented | `analytics/throughput.ts` |
| Inventory view in the Operations Explorer | Proposed | the Explorer "Inventory" tab is a "Coming soon" placeholder; `selectors.ts` has `inventoryByLocation` and the station panel shows stock at a location. (This row previously said Implemented, which the code did not support.) |
| Material shortage impact (blocked work orders, short materials, open-PO supply cover) | Implemented | `analytics/materialShortages.ts`, Explorer "Material Shortages" tab, `tests/materialShortages.test.ts`; list equals the dashboard shortage KPI; observed facts, no release prediction, no allocation between orders |
| Playback controls, accelerated time, seek | Implemented | `SimulationController`, `PlaybackToolbar` |
| 3D factory with selection and status colouring | Implemented | `src/graphics/`; assembly band laid out as a west -> east process line (kitting, mechanical, wiring A/B, controls & motor, flex) |
| Shift state in the UI (on/off shift, next shift, weekday in dates) | Implemented | playback toolbar badge, Work Centers banner, faded 3D queues; waits and the bottleneck flag respect shifts (Mon-Fri 06:00-18:00 UTC) |
| Bill of materials per product (Explorer "Bill of Materials" tab) | Implemented | `analytics/billOfMaterials.ts`; master data, quantities per finished unit, standard cost totals reconcile to `Product.standardCostCents` |
| Work-center queue buffers and bottleneck highlight in 3D | Implemented | `WipBuffers`, `data/queueBuffers.ts`; drawn at each work center's lead station from `workCenterQueues`, the same definition as the Work Centers tab; capped at 6 boxes per work center (counts in the tab) |
| Performance overlay (`?perf` / `P`) | Implemented | `PerfOverlay`; baselines in `docs/PERFORMANCE.md` |
| Static hosting and release tooling | Implemented | `deploy/`, `.github/workflows/ci.yml` |
| Public roadmap page | Implemented | `public/roadmap/index.html` |
| Material-movement animation in 3D | Proposed | `factoryObjectsForEvent` already returns `flows`; nothing animates them yet |
| 3D selection linked to work-order detail | Partial | station panel "Open WO detail" button opens the Explorer drawer for the station's current order; no unit-level link |
| Bottleneck contributing conditions ("why" panel on the Work Centers tab) | Implemented | `analytics/bottleneck.ts`, `tests/bottleneck.test.ts`; independent, indicative observations (queue load, stations down, equipment, downtime, utilization, changeovers, material), not root-cause analysis; equipment and backlog are current-state only |
| Root-cause analysis and automated bottleneck diagnosis | Proposed | design §8.4, §9.3; deliberately not claimed |
| Order dispatch and lead-time analytics (Order-to-Final-Dispatch Lead Time, Dispatch Lateness, Past-Due Unshipped Orders, On-Time In-Full Dispatch, Quantity Fill by Due Date) | Implemented | `analytics/dispatch.ts`, Explorer "Dispatch" tab, `tests/dispatch.test.ts`; dispatch basis (no customer-receipt data), observed facts only, no forecast; definitions in `KPI_DEFINITIONS.md` |
| Work-order elapsed-time decomposition, flow/cycle time and contributing conditions (S1b) | Implemented | `analytics/workOrderTime.ts`, work-order drawer sections, `tests/workOrderTime.test.ts`; exclusive categories sum exactly to elapsed time; conditions are indicative and overlapping; equipment and backlog are current-state observations only; open orders counted to the current simulated time |
| Quality and scrap analytics (first-pass yield, rework and scrap rate, re-test pass rate, defect Pareto, cause, by product and QC station) | Implemented | `analytics/quality.ts`, Explorer "Quality" tab, `tests/quality.test.ts`; first-pass yield equals the dashboard KPI; cause shown only where recorded |
| Capability-aware UX (known / inferred / forecast) | Proposed | design §12.3 |

## Quality and process

| Capability | Status | Where / note |
| --- | --- | --- |
| Unit and simulation tests | Implemented | `tests/*.test.ts` |
| Contract tests on a committed canonical fixture | Implemented | `tests/contract.test.ts`, `tests/fixtures/canonical/` |
| Recorded performance baseline | Implemented | `docs/PERFORMANCE.md` (numbers, not a CI gate) |
| CI: typecheck, test, validate, build | Implemented | `.github/workflows/ci.yml` |
| Strict typing across the whole app | Partial | strict only for `manufacturing`, scripts, tests, examples |
| Automated UI or 3D tests | Proposed | verified manually today |
| Lint / formatter configuration | Proposed | none configured |

## Known limitations of the implemented behaviour

- Selecting a feed entry highlights only the primary related station or location.
- Assembly stations share one global waiting queue; inspection stations show orders awaiting QC.
- Good units are attributed at finished-goods receipt time, not build time.
- Utilization counts run time after shift end against the shift and is capped at 100% per station.
- The progress bar ends at the last event; the dataset is a fixed 30-day synthetic run.
- All data is synthetic and must stay labelled as such.
- The production bundle is about 650 kB (mostly Three.js) and is not code-split.
