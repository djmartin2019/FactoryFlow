# Architecture: from data to every on-screen number

This documents what the code does **today**. For intent and the target architecture see
`docs/FACTORYFLOW_DESIGN.md`; for what is built versus proposed see `docs/STATUS.md`.

## 1. The path

```
generator.ts (seeded)                       scripts/generate.ts
   │  proposes events through the reducer      writes data/generated/*.json
   ▼
initial_state.json  +  events.json     (served as public/data → data/generated)
   │  loadSimulationData.ts
   ▼
FactoryReplay (replay.ts)   ◀── SimulationController (the ONE clock; speed, play/pause, seek)
   │  applyEventInPlace (state.ts) mutates FactoryState; listeners get (event, state)
   ▼
FactoryState + MasterData + applied events
   ├─ selectors.ts / dashboardMetrics.ts ──▶ ui/Dashboard ▸ KpiCards, StationOverview, StationDetails
   ├─ eventFormat.ts (describeEvent) ──▶ ActivityLog ──▶ ui/ActivityFeed
   ├─ mapping.ts (entity/event → 3D object ids) ──▶ graphics/FactoryVisualizer, InteractionManager
   └─ simulation/reportingSnapshot.ts ──▶ analytics/* ──▶ ui/explorer (orders, analytics, inventory)
```

Only `FactoryReplay` writes state. Everything downstream reads.

## 2. Layers and dependency direction

| Layer | Path | Depends on |
| --- | --- | --- |
| Domain core | `src/manufacturing/` | nothing (pure TS) |
| Clock + loading | `src/simulation/` | manufacturing |
| Analytics | `src/analytics/` | manufacturing types only (`ReportingSnapshot` is the input) |
| 3D layout data | `src/data/factoryLayout.ts` | `layoutTypes.ts` |
| Rendering | `src/graphics/` | manufacturing (mapping, types), data, simulation |
| UI | `src/ui/` | manufacturing, analytics, simulation |

Dependencies point down the table. The domain core and analytics must never import `three`, the DOM or `ui`.

## 3. Identifiers and relationships

IDs are strings with a prefix (see `src/manufacturing/types.ts`, `generator.ts`): `EVT-000123` events,
`WO-0001` production orders, plus customer orders, purchase orders, shipments and master-data IDs such as
`ASM-001` / `QC-001` for workstations. Locations and workstations share IDs with `factoryLayout.ts` objects,
which is what lets `mapping.ts` resolve a record to a 3D object without a lookup table.

```
Customer ─▶ CustomerOrder ─▶ (allocation from FG stock | ProductionOrder) ─▶ Shipment
Supplier ─▶ PurchaseOrder ─▶ SupplierReceipt ─▶ InventoryBalance (per location+item)
Product ─▶ BillOfMaterials ─▶ Material;   Product ─▶ Routing ─▶ ProductionOperation (per order)
ProductionOrder ─▶ MaterialReservation / MaterialConsumption / QualityInspection / WorkstationAssignment
Workstation ─▶ Downtime, WorkstationRuntime
```

Inventory is keyed by `inventoryKey(locationId, itemId)`.

## 4. Event contract

An event is `{ id, sequence, timestamp, type, entities, payload }` (`EventEnvelope`, `types.ts`).

- `sequence` is global and contiguous from 1; `id` is derived from it (`eventIdFor`).
- `entities` is derived from the payload by `entityRefsFor` (`events.ts`) and stored for fast tracing.
- `payload` is typed per `EventType` in `EventPayloads` (22 types). Event-table: `src/manufacturing/README.md`.
- An event the reducer rejects throws `InvariantViolation`; `replayWithGuard` reports instead of throwing.
- Stream = `initial_state.json` (master data + opening state) + ordered `events.json`.

### Schema history
- **1.2.0** (Phase 1, work centers): additive. `MasterData.workCenters` and `Workstation.workCenterIds` are new;
  reducer rule "assembly operations run on the order's assigned workstation" became "the station serves the
  operation's work center" (skipped when master data has no `workCenterIds`, so 1.1.0 logs still replay).
  `assignedWorkstationId` now means the current or last assembly station and moves as an order hops. The
  generator dispatches per operation, so 1.2.0 datasets differ from 1.1.0 ones for the same seed.
- **1.1.0** (Phase 1, per-product routings): additive. `OperationType` gains `KIT`, `MOUNT`, `WIRE`, `CONFIGURE`;
  `RoutingStep` and `ProductionOperation` gain optional `workCenterId` (reducer checks they agree). No event
  shape changed. Migration: 1.0.0 logs replay unchanged (the field is optional); orders in 1.0.0 data keep the
  old 3-step routings (`MOUNT_AND_WIRE`, `PLC_HMI_INTEGRATION`), so only regenerated data shows the new sequences. Synthetic abstractions: work centers, step durations and the absence of a disposition operation.
  A real MES/ERP adapter must supply routing steps with work center, standard times and operation status events.

## 5. Clocks

| Clock | Where | Meaning |
| --- | --- | --- |
| Event time | `event.timestamp` | When it happened in the simulated world (ISO UTC). |
| State `asOf` | `FactoryState.asOf` | Timestamp of the last applied event. |
| Simulation time | `SimulationController.currentTime` | Playback position; advanced by `dt × speed`. Events with `timestamp <= currentTime` are applied. |
| Epoch | `SimulationController.epoch` | Bumped when history is discarded (reset/backward seek) so caches invalidate. |
| Working calendar | `calendar.ts` | Mon–Fri 06:00–18:00 UTC; used by utilization and the generator. |

The dashboard refreshes on its own 250 ms timer; the render loop calls `simulation.update(dt)`.

## 6. Where each on-screen number comes from

| On screen | Computed by | Source records |
| --- | --- | --- |
| KPI cards (6) | `computeKpis` (`dashboardMetrics.ts`) | production orders, quality inspections, station metrics |
| Station table / details | `stationMetrics`, `workstationViews`, `recordsForFactoryObject` | workstation runtime, orders, downtime, inventory |
| Activity feed | `describeEvent` → `ActivityLog` (ring of 200, 20 shown) | event log |
| Inventory by location | `inventoryByLocation` (`selectors.ts`) | inventory balances |
| Work-order list / drawer | `workOrderSummaries`, `workOrderDetail` (`analytics/workOrders.ts`) | production orders, operations, applied events |
| Throughput chart | `goodUnitsThroughput` (`analytics/throughput.ts`) | production orders (`completedAt`, `finishedGoodsReceivedQuantity`) |
| 3D station colours / highlights | `FactoryVisualizer.update`, `factoryObjectsForEvent` | station status, events |
| Playback time / progress | `SimulationController` | clock |

KPI definitions (numerator, denominator, period, edge cases): `docs/KPI_DEFINITIONS.md`, authored in
`KPI_DEFINITIONS` in `dashboardMetrics.ts` and shown in card tooltips.

## 7. Boundaries and known coupling

- `ui/` and `graphics/` receive the live `FactoryState` via `SimulationController.state` and
  `simulation.engine.master` (`SceneManager.ts`, `Dashboard.ts`). They treat it as read-only by
  convention, not by type enforcement.
- `reportingSnapshot.ts` is the adapter for analytics: it caches the applied-event slice per
  `(position, epoch)` and hands analytics an immutable-by-convention view.
- `mapping.ts` is the adapter between domain entities and 3D object IDs. The domain refers to objects by ID
  only; it holds no scene objects.
- Not enforced: strict TypeScript covers `manufacturing/`, scripts, tests and examples only
  (`tsconfig.node.json`); `src/analytics`, `src/simulation`, `src/graphics` and `src/ui` are checked by the
  non-strict app config.

## 8. Tests per layer

| Layer | Tests |
| --- | --- |
| Generator, reducer, validation, replay | `tests/manufacturing.test.ts` |
| Contracts on a fixed fixture | `tests/contract.test.ts`, `tests/fixtures/canonical/` |
| KPIs | `tests/dashboardMetrics.test.ts` |
| Analytics | `tests/analytics.test.ts` |
| Layout / 3D objects | `tests/factoryLayout.test.ts`, `tests/factoryObject.test.ts` |
| Data on disk + determinism | `npm run validate:data` |

Not covered by automated tests: DOM components and the Three.js scene at runtime (verified manually).
