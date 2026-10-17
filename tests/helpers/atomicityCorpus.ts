/**
 * Rejection corpus: one or more scenarios per `EventType`. Exhaustive on purpose (typed `Record<EventType, ...>`),
 * following tests/contract.test.ts. Every entry is built from a real dataset event so that it reaches the intended
 * check; the comment on each says which check fires and, for `knownPartial`, what is mutated first.
 */
import { applyEventInPlace } from "../../src/manufacturing/state.ts";
import type { FactoryEvent, FactoryState } from "../../src/manufacturing/types.ts";
import { dataset, pickEvent, redelivered, setBalance, type Corpus, type CorpusEntry } from "./atomicity.ts";

const master = () => dataset().master;
const rawStorage = () => master().locations.find((l) => l.kind === "RAW_STORAGE")!.id;
const key = (loc: string, item: string) => `${loc}::${item}`;

/** A first-in-time shipment/receipt/etc. donor edited by `edit`, optionally after editing the state. */
function entry<T extends FactoryEvent["type"]>(
  type: T,
  name: string,
  pick: (e: any, s: FactoryState) => boolean,
  edit: (e: any, s: FactoryState) => void,
  extra: Partial<CorpusEntry> = {},
): CorpusEntry {
  return {
    name,
    build: () => {
      const sc = pickEvent(type as never, pick as never);
      edit(sc.event, sc.state);
      return sc as never;
    },
    ...extra,
  };
}

const any = () => true;

export const corpus: Corpus = {
  PURCHASE_ORDER_CREATED: [
    { name: "duplicate purchase order", build: () => redelivered("PURCHASE_ORDER_CREATED") },
    entry("PURCHASE_ORDER_CREATED", "material not supplied by the PO's supplier", any, (e) => {
      e.payload.purchaseOrder.supplierId = master().suppliers.find((s) => s.id !== e.payload.purchaseOrder.supplierId)!.id;
    }),
  ],

  MATERIAL_RECEIVED: [
    { name: "duplicate receipt", build: () => redelivered("MATERIAL_RECEIVED") },
    // The first line is applied (PO line quantity + inventory move) before the second line's ordered-quantity check fails.
    entry("MATERIAL_RECEIVED", "second line exceeds ordered quantity", (e) => e.payload.receipt.lines.length > 1, (e, s) => {
      const po = s.purchaseOrders[e.payload.receipt.purchaseOrderId];
      const last = e.payload.receipt.lines.at(-1)!;
      last.quantity = po.lines.find((l) => l.id === last.purchaseOrderLineId)!.orderedQuantity + 1;
    }, { knownPartial: true }),
    // A null line raises TypeError (not InvariantViolation) after line 0 has been applied.
    entry("MATERIAL_RECEIVED", "malformed second line raises TypeError", (e) => e.payload.receipt.lines.length > 1, (e) => {
      e.payload.receipt.lines[1] = null;
    }, { knownPartial: true }),
  ],

  INVENTORY_TRANSFERRED: [
    entry("INVENTORY_TRANSFERRED", "transfer exceeds available stock", any, (e) => {
      e.payload.transfer.quantity = 1_000_000_000;
    }),
    entry("INVENTORY_TRANSFERRED", "unknown destination location", any, (e) => {
      e.payload.transfer.toLocationId = "LOC-NOPE";
    }),
  ],

  CUSTOMER_ORDER_CREATED: [
    { name: "duplicate customer order", build: () => redelivered("CUSTOMER_ORDER_CREATED") },
    entry("CUSTOMER_ORDER_CREATED", "unknown product on a line", any, (e) => {
      e.payload.customerOrder.lines[0].productId = "NOPE";
    }),
  ],

  CUSTOMER_ORDER_CANCELLED: [
    entry("CUSTOMER_ORDER_CANCELLED", "unknown customer order", any, (e) => {
      e.payload.customerOrderId = "CO-NOPE";
    }),
    // Line 1's allocation is released, then line 2's reserved stock is missing.
    entry("CUSTOMER_ORDER_CANCELLED", "second allocated line cannot release its reservation", any, (e, s) => {
      const order = s.customerOrders[e.payload.customerOrderId];
      const [p1, p2] = master().products;
      const base = order.lines[0];
      order.lines = [
        { ...base, id: "L-A", lineNumber: 1, productId: p1.id, quantity: 2, allocatedQuantity: 1, shippedQuantity: 0 },
        { ...base, id: "L-B", lineNumber: 2, productId: p2.id, quantity: 2, allocatedQuantity: 1, shippedQuantity: 0 },
      ];
      setBalance(s, p1.finishedGoodsLocationId, p1.id, "FINISHED_GOOD", 5, 1);
      setBalance(s, p2.finishedGoodsLocationId, p2.id, "FINISHED_GOOD", 5, 0);
    }, { knownPartial: true }),
  ],

  PRODUCTION_ORDER_CREATED: [
    { name: "duplicate production order", build: () => redelivered("PRODUCTION_ORDER_CREATED") },
    // Characterization: the per-operation duplicate check reads state, which is only written after the loop, so two
    // operations with one id inside a single event are ACCEPTED today and the second silently overwrites the first.
    entry("PRODUCTION_ORDER_CREATED", "duplicate operation ids within one event (accepted today)", any, (e) => {
      const ops = e.payload.operations;
      ops[1].id = ops[0].id;
      e.payload.productionOrder.operationIds = ops.map((o: { id: string }) => o.id);
    }, { expected: "accept", cumulative: "duplicate operation ids" }),
  ],

  PRODUCTION_ORDER_RELEASED: [
    { name: "order already holds reservations", build: () => redelivered("PRODUCTION_ORDER_RELEASED") },
    // Reservations are applied one by one; the last material has no available stock left.
    entry("PRODUCTION_ORDER_RELEASED", "later material is short after earlier reservations were applied", (e) => e.payload.reservations.length > 1, (e, s) => {
      const r = e.payload.reservations.at(-1)!;
      const b = s.inventory[key(r.locationId, r.materialId)];
      b.onHand = b.reserved + r.quantity - 1;
    }, { knownPartial: true, cumulative: "shorted second reservation" }),
  ],

  PRODUCTION_ORDER_CANCELLED: [
    entry("PRODUCTION_ORDER_CANCELLED", "unknown production order", any, (e) => {
      e.payload.productionOrderId = "WO-NOPE";
    }),
    // The first reservation is released, then the second one's reserved stock is missing.
    entry("PRODUCTION_ORDER_CANCELLED", "later reservation cannot be released", any, (e, s) => {
      const order = s.productionOrders[e.payload.productionOrderId];
      const [m1, m2] = master().materials;
      order.reservations = [
        { materialId: m1.id, quantity: 1, locationId: m1.storageLocationId },
        { materialId: m2.id, quantity: 1, locationId: m2.storageLocationId },
      ];
      setBalance(s, m1.storageLocationId, m1.id, "RAW_MATERIAL", 5, 1);
      setBalance(s, m2.storageLocationId, m2.id, "RAW_MATERIAL", 5, 0);
    }, { knownPartial: true }),
  ],

  PRODUCTION_BLOCKED: [
    entry("PRODUCTION_BLOCKED", "claimed shortage does not match inventory", (e) => e.payload.reason === "MATERIAL_SHORTAGE", (e) => {
      e.payload.shortages[0].available += 1;
    }),
    entry("PRODUCTION_BLOCKED", "machine block on an order that is not RUNNING", (e) => e.payload.reason === "MACHINE_DOWN", (e, s) => {
      s.productionOrders[e.payload.productionOrderId].status = "WAITING";
    }),
  ],

  PRODUCTION_RESUMED: [
    entry("PRODUCTION_RESUMED", "workstation is not restored", any, (e, s) => {
      s.workstations[e.payload.workstationId].status = "DOWN";
    }),
  ],

  MATERIAL_CONSUMED: [
    entry("MATERIAL_CONSUMED", "material was never reserved", any, (e) => {
      e.payload.consumptions[0].materialId = "MAT-NOPE";
    }),
    // The first consumption is applied, then the second names a non-assembly destination.
    entry("MATERIAL_CONSUMED", "second consumption lands on a non-assembly location", (e) => e.payload.consumptions.length > 1, (e) => {
      e.payload.consumptions[1].toLocationId = rawStorage();
    }, { knownPartial: true }),
    // Entry 2 duplicates entry 1; the stock holds exactly one entry's worth, so the second consumption underflows.
    entry("MATERIAL_CONSUMED", "duplicate consumption entries", (e) => e.payload.consumptions.length > 1, (e, s) => {
      const [c0] = e.payload.consumptions;
      e.payload.consumptions[1] = { ...c0 };
      setBalance(s, c0.fromLocationId, c0.materialId, "RAW_MATERIAL", c0.quantity, c0.quantity);
      // The order still lists a reservation for the replaced material; keep the length check satisfied.
    }, { knownPartial: true, cumulative: "duplicate consumption entries" }),
  ],

  PRODUCTION_STARTED: [
    entry("PRODUCTION_STARTED", "workstation is down", any, (e, s) => {
      s.workstations[e.payload.workstationId].status = "DOWN";
    }),
  ],

  OPERATION_STARTED: [
    entry("OPERATION_STARTED", "operation is not PENDING", any, (e, s) => {
      s.productionOperations[e.payload.productionOperationId].status = "COMPLETED";
    }),
    // Needs two crimp tools; the first is marked held, then the second is found busy.
    entry("OPERATION_STARTED", "second equipment unit is busy", (e, s) => s.productionOperations[e.payload.productionOperationId].requiredEquipment?.length === 1 && e.payload.equipmentIds?.[0] === "EQ-CRIMP-01", (e, s) => {
      const op = s.productionOperations[e.payload.productionOperationId];
      op.requiredEquipment = ["CRIMP_TOOL", "CRIMP_TOOL"];
      e.payload.equipmentIds = ["EQ-CRIMP-01", "EQ-CRIMP-02"];
      s.equipment!["EQ-CRIMP-02"].currentOperationId = "OP-SOMEONE-ELSE";
    }, { knownPartial: true, cumulative: "second equipment unit busy" }),
  ],

  OPERATION_COMPLETED: [
    entry("OPERATION_COMPLETED", "operation is not running on that workstation", any, (e) => {
      e.payload.workstationId = "ASM-NOPE";
    }),
    // The operation is completed, the station idled and equipment released, then rework quantity goes negative.
    entry("OPERATION_COMPLETED", "rework quantity underflow", (e, s) => s.productionOperations[e.payload.productionOperationId].isRework, (e, s) => {
      s.productionOrders[e.payload.productionOrderId].reworkPendingQuantity = 0;
    }, { knownPartial: true, cumulative: "rework quantity underflow" }),
  ],

  PRODUCTION_COMPLETED: [
    entry("PRODUCTION_COMPLETED", "produced quantity differs from the order", any, (e) => {
      e.payload.quantityProduced += 1;
    }),
  ],

  QUALITY_INSPECTION_COMPLETED: [
    entry("QUALITY_INSPECTION_COMPLETED", "passed + failed does not equal inspected", any, (e) => {
      e.payload.inspection.passedQuantity += 1;
    }),
    { name: "duplicate inspection", build: () => redelivered("QUALITY_INSPECTION_COMPLETED") },
  ],

  REWORK_REQUESTED: [
    entry("REWORK_REQUESTED", "quantity does not match the failed inspection", any, (e) => {
      e.payload.quantity += 1;
    }),
    // The REWORK operation is inserted, then the retest reuses its id.
    entry("REWORK_REQUESTED", "retest operation reuses the rework operation id", any, (e) => {
      e.payload.operations[1].id = e.payload.operations[0].id;
    }, { knownPartial: true, cumulative: "duplicate operation ids" }),
  ],

  FINISHED_GOODS_RECEIVED: [
    entry("FINISHED_GOODS_RECEIVED", "quantity is not the QC-approved remainder", any, (e) => {
      e.payload.quantity += 1;
    }),
    // Inventory is moved and counters changed, then the order fails to close at zero WIP.
    entry("FINISHED_GOODS_RECEIVED", "WIP does not close", (e) => e.payload.quantity > 0, (e, s) => {
      s.productionOrders[e.payload.productionOrderId].wipQuantity += 1;
    }, { knownPartial: true, cumulative: "WIP not closing" }),
  ],

  FINISHED_GOODS_ALLOCATED: [
    entry("FINISHED_GOODS_ALLOCATED", "allocation exceeds open quantity", any, (e) => {
      e.payload.quantity = 1_000_000;
    }),
  ],

  SHIPMENT_DISPATCHED: [
    { name: "duplicate shipment", build: () => redelivered("SHIPMENT_DISPATCHED") },
    // Line 1 ships, then line 2 asks for more than is allocated.
    entry("SHIPMENT_DISPATCHED", "second line exceeds its allocation", (e) => e.payload.shipment.lines.length > 1, (e, s) => {
      const order = s.customerOrders[e.payload.shipment.customerOrderId];
      const last = e.payload.shipment.lines.at(-1)!;
      last.quantity = order.lines.find((l) => l.id === last.customerOrderLineId)!.allocatedQuantity + 1;
    }, { knownPartial: true }),
    // Two lines on one order line, each within the allocation, together above it: the second sees the first's effect.
    entry("SHIPMENT_DISPATCHED", "two lines on the same order line exceed its allocation together", any, (e, s) => {
      const order = s.customerOrders[e.payload.shipment.customerOrderId];
      const l0 = e.payload.shipment.lines[0];
      const allocated = order.lines.find((l) => l.id === l0.customerOrderLineId)!.allocatedQuantity;
      l0.quantity = allocated;
      e.payload.shipment.lines = [l0, { ...l0, id: `${l0.id}-X`, quantity: 1 }];
    }, { knownPartial: true, cumulative: "same-line shipments" }),
    // A null line raises TypeError after line 0 shipped.
    entry("SHIPMENT_DISPATCHED", "malformed second line raises TypeError", (e) => e.payload.shipment.lines.length > 1, (e) => {
      e.payload.shipment.lines[1] = null;
    }, { knownPartial: true }),
  ],

  MACHINE_FAILED: [
    entry("MACHINE_FAILED", "workstation is already down", any, (e, s) => {
      s.workstations[e.payload.workstationId].status = "DOWN";
    }),
    // The downtime record is inserted before the lookup of the station's current operation fails.
    entry("MACHINE_FAILED", "station points at a missing operation", any, (e, s) => {
      s.workstations[e.payload.workstationId].currentOperationId = "OP-MISSING";
    }, { knownPartial: true }),
  ],

  MACHINE_RESTORED: [
    entry("MACHINE_RESTORED", "unknown downtime", any, (e) => {
      e.payload.downtimeId = "DT-NOPE";
    }),
  ],
};

/** The applyEventInPlace reference used by the corpus tests. */
export const reducer = applyEventInPlace;
