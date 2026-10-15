# Northstar Components – manufacturing data model

Synthetic, deterministic, event-sourced manufacturing history for FactoryFlow.
Pure TypeScript: no Three.js, no DOM, no backend, no extra runtime dependencies.

## Commands

| Command | What it does |
| --- | --- |
| `npm run generate:data` | Generate, self-validate and write `data/generated/*.json` |
| `npm run generate:data -- --seed=abc --days=45 --customerOrders=120` | Override config (see below) |
| `npm run validate:data` | Re-validate the files on disk and regenerate from the manifest seed to prove determinism |
| `npm test` | Vitest suite (no frontend needed) |
| `npm run typecheck` | Strict typecheck of the manufacturing code, scripts, tests, examples |
| `npm run example:replay` | Load the dataset into the replay engine and print dashboard-style views |

Config options: `seed`, `startDate`, `days`, `customerOrders`, `purchaseOrders`, `customerCount` (≤10),
`assemblyWorkstations` (1–3), `inspectionWorkstations` (1–2), `openingFinishedGoodsUnits`, `minProductionLot`,
`machineFailuresPerWorkstation`, `noSurge`. Defaults live in `masterData.ts` (`DEFAULT_CONFIG`).

Counts: `customerOrders` is exact. Purchase orders and production orders are **demand/policy driven**, not
quotas – at defaults you get ≈47 POs (target 50 sets the supplier review cycle) and ≈100 production orders.

## Layout

```
types.ts       domain interfaces, event payloads, config, manifest
rng.ts         seeded RNG (xmur3 → mulberry32) with forkable streams
masterData.ts  Northstar products/BOMs/routings/suppliers/customers/locations/workstations
state.ts       FactoryState + applyEvent (pure) / applyEventInPlace – ALL business rules live here
events.ts      event envelope + entity-ref derivation
generator.ts   discrete-event simulation that proposes events through the reducer
validation.ts  independent invariant checks over a finished dataset
replay.ts      FactoryReplay – simulated-clock replay engine
mapping.ts     entity/event → existing 3D object IDs
selectors.ts   dashboard-shaped read models
tables.ts      state → output files
calendar.ts    shift calendar (Mon–Fri 06:00–18:00 UTC)
```

Units: money = integer USD cents; quantities = integers in the item UoM (EA/KIT/M); durations = integer
minutes; timestamps = ISO 8601 UTC.

## The company

NCP-100 Basic, NCP-200 Motor, NCP-300 Advanced Automation panels; 13 materials (enclosures S/M/L, 1P/3P
breakers, terminal blocks, DIN rail, wiring kits, relays, contactors, PLC CPU, HMI, power supply), 5 suppliers
(Ironbridge Metalworks, Voltaic Switchgear, Clearline Connectors, Meridian Automation Supply, Brightwater
Power Systems), 10 customers (Alder Valley Packaging … Juniper Bay Pumps). All fictional.

Routings: NCP-100 `MOUNT_AND_WIRE → FINAL_TEST`; NCP-200 `MOUNT_AND_WIRE → MOTOR_CIRCUIT_ASSEMBLY → FINAL_TEST`;
NCP-300 `MOUNT_AND_WIRE → PLC_HMI_INTEGRATION → FINAL_TEST`. Assembly steps run on ASM-00x, FINAL_TEST on QC-00x;
each workstation runs one job at a time.

## Authoritative replay source

`initial_state.json` (master data + opening balances) **+** `events.json` (ordered) is the source of truth.
Every other table is derived from replaying them; `final_state.json` must equal that replay, and validation
checks it. Events carry `id` (`EVT-000123`), `sequence` (global, strictly increasing – breaks timestamp ties),
`timestamp`, `type`, `entities` (derived entity IDs) and a typed `payload`.

| Event | Effect |
| --- | --- |
| `PURCHASE_ORDER_CREATED` | PO opens (reorder-point policy) |
| `MATERIAL_RECEIVED` | PO lines received (+on-hand at REC dock); `daysLate`/`delayReason`/`shortShipment` recorded |
| `INVENTORY_TRANSFERRED` | Put-away REC → INV rack; only *available* stock may move |
| `CUSTOMER_ORDER_CREATED` / `_CANCELLED` | Demand appears / disappears (cancel releases FG allocations) |
| `PRODUCTION_ORDER_CREATED` | Order + routing operations planned |
| `PRODUCTION_BLOCKED` | `MATERIAL_SHORTAGE` (lists short materials + open POs; verified against inventory) or `MACHINE_DOWN` (links downtime) |
| `PRODUCTION_ORDER_RELEASED` | Reserves exactly BOM × qty (+reserved) → WAITING |
| `PRODUCTION_ORDER_CANCELLED` | Releases unused reservations |
| `MATERIAL_CONSUMED` | Reserved stock leaves raw storage, becomes WIP at the assembly station |
| `PRODUCTION_STARTED` / `OPERATION_STARTED` / `OPERATION_COMPLETED` | Assignment + per-operation execution |
| `MACHINE_FAILED` / `MACHINE_RESTORED` | Station down/up; running operation pauses, `PRODUCTION_RESUMED` continues it |
| `PRODUCTION_COMPLETED` | Assembly done; units wait for QC (still WIP) |
| `QUALITY_INSPECTION_COMPLETED` | passed / rework / scrap split with defect codes and cause |
| `REWORK_REQUESTED` | Appends `REWORK` + re-test operations |
| `FINISHED_GOODS_RECEIVED` | Exactly the QC-approved units move WIP → FG (+on-hand). Zero-yield orders close with 0 |
| `FINISHED_GOODS_ALLOCATED` | Reserves available FG for one order line |
| `SHIPMENT_DISPATCHED` | Allocated FG leaves (−on-hand, −reserved); shipped ≤ allocated |

## Inventory & WIP rules

Three quantities per item per location: `onHand`, `reserved`, `available = onHand − reserved`. The reducer's
single `move()` function enforces `0 ≤ reserved ≤ onHand` on every transaction, so available can never go
negative.

1. **Receive** – PO line qty lands at a receiving dock (+onHand). Cannot exceed ordered qty.
2. **Transfer** – dock → rack put-away; reserved stock cannot move.
3. **Reserve** – at `PRODUCTION_ORDER_RELEASED`, BOM × qty is reserved at raw storage. Partial reservation is not allowed: an order is released whole or blocked.
4. **Consume → WIP** – at `MATERIAL_CONSUMED` (same instant as `PRODUCTION_STARTED`) reservations are consumed. This is the moment raw material becomes WIP; `wipQuantity = order.quantity` and tracks the order's units until FG receipt or scrap.
5. **Release** – cancelling an unstarted order returns reservations.
6. **Quality** – failed units are reworked once (back to the same assembly station, then re-tested) or scrapped; scrapped units leave WIP.
7. **FG receipt** – only QC-approved units; the reducer rejects anything else.
8. **Allocate / ship** – FG is reserved per order line; a shipment line cannot exceed that line's allocation.

Duplicate/out-of-order processing is rejected by sequence number and by unique record IDs. Invalid
transitions throw `InvariantViolation` and `applyEvent` leaves its input untouched.

## Where variability comes from (all traceable)

| Condition | Cause → effect chain in the log |
| --- | --- |
| Supplier delay | PO's supplier misses `onTimeRate` → receipt with `daysLate` + `delayReason` (possibly split via `shortShipment`) → material shortage blocks |
| Material shortage | `PRODUCTION_BLOCKED{MATERIAL_SHORTAGE, shortages[{required, available, expectedPurchaseOrderIds}]}` → released after the putaway that closes the gap |
| Machine downtime | `MACHINE_FAILED` → op `PAUSED` → `PRODUCTION_BLOCKED{MACHINE_DOWN, downtimeId}` → `MACHINE_RESTORED` → `PRODUCTION_RESUMED` |
| Bottleneck | Orders pile up WAITING for the six assembly stations after a shortage clears; ASM-002 is slower (`durationFactor` from layout capacity) |
| Quality failure | Base rate per product; ×3 for units whose assembly was interrupted by a failure (`cause: MACHINE_FAILURE, downtimeId`) |
| Demand fluctuation | Surge window (days 12–16 by default) produces `SURGE_CAMPAIGN` orders for NCP-200, which the (average-usage) purchase planner did not forecast |

## Output files (`data/generated/`)

`manifest`, `materials`, `products`, `bills_of_materials`, `routings`, `suppliers`, `customers`, `workstations`,
`departments`, `locations`, `purchase_orders`, `receipts`, `inventory_balances`, `inventory_transactions`,
`production_orders`, `production_operations`, `workstation_assignments`, `quality_inspections`, `downtimes`,
`customer_orders`, `shipments`, `events`, `initial_state`, `final_state`.
The manifest holds seed, full config, schema version, event count, simulated range and an event-log hash.

## Consuming the data

```ts
import { FactoryReplay, factoryObjectsForEvent, workstationViews, inventoryByLocation } from "./manufacturing";

const replay = new FactoryReplay(initialStateJson, eventsJson);
replay.onEvent((event, state) => {
  const { objectIds, flows } = factoryObjectsForEvent(event, state); // which meshes / movements
});
// every animation frame:
simulatedNow += dtMs * speed;
replay.advanceTo(new Date(simulatedNow).toISOString());
const views = workstationViews(replay.state, replay.master);        // status + utilization
const stock = inventoryByLocation(replay.state, replay.master);     // per-location inventory
```

See `examples/replay-example.ts` for a runnable version.

## Integration points with the Three.js objects

| Need | API | Mapping |
| --- | --- | --- |
| Location/workstation ↔ mesh | IDs are identical to `factoryLayout` ids | `REC-*`, `INV-*`, `ASM-*`, `QC-*`, `SHP-*` |
| React to an event | `factoryObjectsForEvent(event, state?)` (state only locates the QC station for FG receipts) | `objectIds` to highlight, `flows[{from,to,itemId,quantity}]` to animate (`EXTERNAL` = outside the factory) |
| Station status colour | `workstationViews()[].objectStatus` | `OperationalStatus` (`idle/running/blocked/down`); `blocked` = idle assembly cell while orders wait on material |
| Utilization | `workstationViews()[].utilization` | trailing-window busy ÷ shift minutes (capped at 1; work may run past shift end) |
| Inventory at a location | `inventoryByLocation()` | items + pallets used ÷ `palletCapacity` |
| WIP by station/stage | `wipByLocation()` | keyed by workstation location id |
| Bottlenecks/shortages | `materialShortages()`, `workstationViews()[].queuedOrderIds` | |
| Click → records | `recordsForFactoryObject(objectId, state, master)` | location, workstation runtime, inventory, orders, open POs |
| Record → mesh | `factoryObjectsForEntity({kind, id}, state, master)` | e.g. production order → current location |
| Supplier arrivals | `PURCHASE_ORDER_CREATED` … `MATERIAL_RECEIVED` (`promisedDeliveryAt` vs `receivedAt`) | REC-001/002 |
| FG entering stock / shipping | `FINISHED_GOODS_RECEIVED`, `SHIPMENT_DISPATCHED` | SHP-001 (NCP-100/200), SHP-002 (NCP-300) |

## Assumptions

- The layout has no dedicated finished-goods store, so FG lives at the shipping bays (SHP-001 for NCP-100, SHP-002 for NCP-200, SHP-003 for NCP-300).
- All 6 assembly stations and 3 inspection cells in the layout are active by default; `assemblyWorkstations` / `inspectionWorkstations` activate the first N of each (bounded by the layout).
- `palletCapacity` is a domain value (not the mock `capacity`/`utilization` in `factoryLayout.ts`); the layout's numbers are used only to derive relative station speed.
- Operations start only in shift (Mon–Fri 06:00–18:00 UTC) but run to completion, so some work finishes after 18:00.
- Failures are modelled on assembly stations only; QC is reliable.
- Rework is allowed once per unit; units failing re-inspection are scrapped.
