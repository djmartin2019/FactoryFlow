/**
 * Factory state + pure state-transition function.
 *
 * `applyEvent(state, event, master)` returns a NEW state and throws
 * `InvariantViolation` for anything impossible: negative available stock,
 * duplicate processing, skipped production states, over-shipment, etc.
 * `applyEventInPlace` is the same logic without the defensive copy and is what
 * the generator and replay engine use for speed.
 *
 * Inventory & WIP rules (the single source of truth for the whole module)
 *  RECEIVE   PO line quantity arrives at a receiving dock: +onHand.
 *  TRANSFER  Only *available* stock (onHand - reserved) may move between locations.
 *  RESERVE   PRODUCTION_ORDER_RELEASED reserves exactly BOM x quantity at raw
 *            storage: +reserved. Stock stays on hand and cannot be used by others.
 *  CONSUME   MATERIAL_CONSUMED (immediately before PRODUCTION_STARTED) removes the
 *            reserved stock from raw storage (-onHand, -reserved) and the order's
 *            units become WIP at the assembly workstation. Material is never
 *            consumed without a reservation.
 *  RELEASE   Cancelling an order that has not consumed material returns its
 *            reservation (-reserved).
 *  COMPLETE  PRODUCTION_COMPLETED = assembly done; units wait for QC. Still WIP.
 *  QUALITY   Inspection splits units into passed / rework / scrap. Scrap leaves WIP.
 *  FG        FINISHED_GOODS_RECEIVED moves exactly the QC-approved units out of WIP
 *            into finished goods (+onHand). Nothing else can create finished goods.
 *  ALLOCATE  FINISHED_GOODS_ALLOCATED reserves available FG for one order line.
 *  SHIP      SHIPMENT_DISPATCHED removes allocated FG (-onHand, -reserved); a line
 *            can never ship more than is allocated to it.
 */

import type {
  FactoryEvent,
  FactoryState,
  Id,
  InventoryBalance,
  InventoryTransaction,
  InventoryTransactionType,
  ItemKind,
  IsoTimestamp,
  MasterData,
  ProductionOperation,
  ProductionOrder,
  ProductionStage,
  Quantity,
} from "./types.ts";

export class InvariantViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantViolation";
  }
}

function req(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantViolation(message);
}

// ---------------------------------------------------------------------------
// Master data index (cached per MasterData object)
// ---------------------------------------------------------------------------

interface MasterIndex {
  materials: Map<Id, MasterData["materials"][number]>;
  products: Map<Id, MasterData["products"][number]>;
  suppliers: Map<Id, MasterData["suppliers"][number]>;
  customers: Map<Id, MasterData["customers"][number]>;
  locations: Map<Id, MasterData["locations"][number]>;
  workstations: Map<Id, MasterData["workstations"][number]>;
  bomByProduct: Map<Id, MasterData["billsOfMaterials"][number]>;
  routingByProduct: Map<Id, MasterData["routings"][number]>;
}

const indexCache = new WeakMap<MasterData, MasterIndex>();

export function indexMaster(master: MasterData): MasterIndex {
  let idx = indexCache.get(master);
  if (!idx) {
    idx = {
      materials: new Map(master.materials.map((m) => [m.id, m])),
      products: new Map(master.products.map((p) => [p.id, p])),
      suppliers: new Map(master.suppliers.map((s) => [s.id, s])),
      customers: new Map(master.customers.map((c) => [c.id, c])),
      locations: new Map(master.locations.map((l) => [l.id, l])),
      workstations: new Map(master.workstations.map((w) => [w.id, w])),
      bomByProduct: new Map(master.billsOfMaterials.map((b) => [b.productId, b])),
      routingByProduct: new Map(master.routings.map((r) => [r.productId, r])),
    };
    indexCache.set(master, idx);
  }
  return idx;
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

export function inventoryKey(locationId: Id, itemId: Id): string {
  return `${locationId}::${itemId}`;
}

export function availableOf(balance: Pick<InventoryBalance, "onHand" | "reserved">): Quantity {
  return balance.onHand - balance.reserved;
}

export function createEmptyState(asOf: IsoTimestamp, master: MasterData): FactoryState {
  const workstations: FactoryState["workstations"] = {};
  for (const ws of master.workstations) {
    workstations[ws.id] = { workstationId: ws.id, status: "IDLE", since: asOf };
  }
  return {
    asOf,
    lastSequence: 0,
    inventory: {},
    inventoryTransactions: [],
    inventoryTransfers: {},
    purchaseOrders: {},
    receipts: {},
    productionOrders: {},
    productionOperations: {},
    workstationAssignments: {},
    qualityInspections: {},
    workstations,
    downtimes: {},
    customerOrders: {},
    shipments: {},
  };
}

/** Seed an opening balance (only valid while building the initial state). */
export function setOpeningBalance(
  state: FactoryState,
  locationId: Id,
  itemId: Id,
  itemKind: ItemKind,
  onHand: Quantity,
): void {
  req(state.lastSequence === 0, "opening balances can only be set on the initial state");
  req(Number.isInteger(onHand) && onHand >= 0, "opening balance must be a non-negative integer");
  state.inventory[inventoryKey(locationId, itemId)] = { locationId, itemId, itemKind, onHand, reserved: 0 };
}

export function getBalance(state: FactoryState, locationId: Id, itemId: Id): InventoryBalance | undefined {
  return state.inventory[inventoryKey(locationId, itemId)];
}

export function availableAt(state: FactoryState, locationId: Id, itemId: Id): Quantity {
  const b = getBalance(state, locationId, itemId);
  return b ? availableOf(b) : 0;
}

interface Movement {
  locationId: Id;
  itemId: Id;
  itemKind: ItemKind;
  type: InventoryTransactionType;
  onHandDelta: Quantity;
  reservedDelta: Quantity;
  referenceType: InventoryTransaction["referenceType"];
  referenceId: Id;
}

/** The only function that mutates inventory. Enforces 0 <= reserved <= onHand. */
function move(state: FactoryState, event: FactoryEvent, m: Movement): void {
  req(Number.isInteger(m.onHandDelta) && Number.isInteger(m.reservedDelta), "inventory deltas must be integers");
  const key = inventoryKey(m.locationId, m.itemId);
  const balance = state.inventory[key] ?? { locationId: m.locationId, itemId: m.itemId, itemKind: m.itemKind, onHand: 0, reserved: 0 };
  const onHand = balance.onHand + m.onHandDelta;
  const reserved = balance.reserved + m.reservedDelta;
  req(onHand >= 0, `${m.type}: on-hand of ${m.itemId} at ${m.locationId} would become ${onHand}`);
  req(reserved >= 0, `${m.type}: reserved of ${m.itemId} at ${m.locationId} would become ${reserved}`);
  req(
    reserved <= onHand,
    `${m.type}: available of ${m.itemId} at ${m.locationId} would become ${onHand - reserved} (onHand ${onHand}, reserved ${reserved})`,
  );
  balance.onHand = onHand;
  balance.reserved = reserved;
  state.inventory[key] = balance;
  state.inventoryTransactions.push({
    id: `TXN-${String(state.inventoryTransactions.length + 1).padStart(6, "0")}`,
    eventId: event.id,
    timestamp: event.timestamp,
    type: m.type,
    itemId: m.itemId,
    itemKind: m.itemKind,
    locationId: m.locationId,
    onHandDelta: m.onHandDelta,
    reservedDelta: m.reservedDelta,
    referenceType: m.referenceType,
    referenceId: m.referenceId,
  });
}

function bomRequirements(master: MasterIndex, productId: Id, quantity: Quantity): Map<Id, Quantity> {
  const bom = master.bomByProduct.get(productId);
  req(bom, `no BOM for product ${productId}`);
  return new Map(bom.lines.map((l) => [l.materialId, l.quantityPer * quantity]));
}

const ASSEMBLY_TYPES = new Set(["MOUNT_AND_WIRE", "MOTOR_CIRCUIT_ASSEMBLY", "PLC_HMI_INTEGRATION"]);

function operationsOf(state: FactoryState, order: ProductionOrder): ProductionOperation[] {
  return order.operationIds.map((id) => state.productionOperations[id]);
}

/** Derive stage + WIP location from the order and its operations. */
function refreshOrder(state: FactoryState, master: MasterIndex, order: ProductionOrder): void {
  const ops = operationsOf(state, order);
  const next = ops.find((o) => o.status !== "COMPLETED");
  let stage: ProductionStage;
  if (order.status === "CANCELLED") stage = "CANCELLED";
  else if (order.status === "COMPLETED") stage = "FINISHED";
  else if (order.status === "PLANNED") stage = "PLANNING";
  else if (order.status === "WAITING") stage = "QUEUED";
  else if (order.status === "BLOCKED" && !order.releasedAt) stage = "PLANNING";
  else if (!next) stage = "AWAITING_QC";
  else if (next.type === "FINAL_TEST") stage = next.status === "PENDING" ? "AWAITING_QC" : "QUALITY";
  else if (next.type === "REWORK") stage = "REWORK";
  else stage = "ASSEMBLY";
  order.stage = stage;

  if (order.status === "COMPLETED" || order.status === "CANCELLED") {
    order.currentLocationId = order.status === "COMPLETED" ? master.products.get(order.productId)?.finishedGoodsLocationId : undefined;
    if (order.currentLocationId === undefined) delete order.currentLocationId;
  } else if (order.materialsConsumed) {
    if (stage === "QUALITY" && next?.workstationId) order.currentLocationId = master.workstations.get(next.workstationId)?.locationId;
    else if (stage === "AWAITING_QC") order.currentLocationId = [...master.workstations.values()].find((w) => w.kind === "INSPECTION")?.locationId;
    else if (order.assignedWorkstationId) order.currentLocationId = master.workstations.get(order.assignedWorkstationId)?.locationId;
  }
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function applyEvent(state: FactoryState, event: FactoryEvent, master: MasterData): FactoryState {
  const next = structuredClone(state);
  applyEventInPlace(next, event, master);
  return next;
}

export function applyEventInPlace(state: FactoryState, event: FactoryEvent, masterData: MasterData): void {
  const m = indexMaster(masterData);

  // Duplicate / out-of-order processing guards.
  req(event.sequence === state.lastSequence + 1, `event ${event.id}: expected sequence ${state.lastSequence + 1}, got ${event.sequence}`);
  req(Date.parse(event.timestamp) >= Date.parse(state.asOf), `event ${event.id}: timestamp ${event.timestamp} precedes ${state.asOf}`);

  const location = (id: Id) => {
    const l = m.locations.get(id);
    req(l, `unknown location ${id}`);
    return l;
  };
  const getOrder = (id: Id) => {
    const o = state.productionOrders[id];
    req(o, `unknown production order ${id}`);
    return o;
  };
  const getOp = (id: Id) => {
    const o = state.productionOperations[id];
    req(o, `unknown production operation ${id}`);
    return o;
  };
  const getWs = (id: Id) => {
    const w = state.workstations[id];
    req(w, `unknown workstation ${id}`);
    return w;
  };
  const getCustomerOrder = (id: Id) => {
    const o = state.customerOrders[id];
    req(o, `unknown customer order ${id}`);
    return o;
  };
  const ts = event.timestamp;

  switch (event.type) {
    // ----- Purchasing -------------------------------------------------------
    case "PURCHASE_ORDER_CREATED": {
      const po = structuredClone(event.payload.purchaseOrder);
      req(!state.purchaseOrders[po.id], `duplicate purchase order ${po.id}`);
      req(m.suppliers.has(po.supplierId), `unknown supplier ${po.supplierId}`);
      req(location(po.receivingLocationId).kind === "RECEIVING", "PO must deliver to a receiving location");
      req(po.status === "OPEN" && po.lines.length > 0, "new PO must be OPEN with at least one line");
      for (const line of po.lines) {
        const mat = m.materials.get(line.materialId);
        req(mat, `unknown material ${line.materialId}`);
        req(mat.supplierId === po.supplierId, `${line.materialId} is not supplied by ${po.supplierId}`);
        req(line.orderedQuantity > 0 && line.receivedQuantity === 0, "PO line must start with ordered > 0, received = 0");
      }
      state.purchaseOrders[po.id] = po;
      break;
    }

    case "MATERIAL_RECEIVED": {
      const receipt = structuredClone(event.payload.receipt);
      req(!state.receipts[receipt.id], `duplicate receipt ${receipt.id}`);
      const po = state.purchaseOrders[receipt.purchaseOrderId];
      req(po, `receipt ${receipt.id} references unknown PO ${receipt.purchaseOrderId}`);
      req(po.status !== "RECEIVED", `PO ${po.id} is already fully received`);
      req(location(receipt.locationId).kind === "RECEIVING", "receipts land at a receiving location");
      req(receipt.lines.length > 0, "receipt has no lines");
      const seen = new Set<Id>();
      for (const rl of receipt.lines) {
        req(!seen.has(rl.purchaseOrderLineId), `receipt ${receipt.id} lists a PO line twice`);
        seen.add(rl.purchaseOrderLineId);
        const line = po.lines.find((l) => l.id === rl.purchaseOrderLineId);
        req(line, `receipt line references unknown PO line ${rl.purchaseOrderLineId}`);
        req(line.materialId === rl.materialId, "receipt material does not match PO line");
        req(rl.quantity > 0, "receipt quantity must be positive");
        req(line.receivedQuantity + rl.quantity <= line.orderedQuantity, `receipt exceeds ordered quantity on ${line.id}`);
        line.receivedQuantity += rl.quantity;
        move(state, event, {
          locationId: receipt.locationId, itemId: rl.materialId, itemKind: "RAW_MATERIAL", type: "RECEIPT",
          onHandDelta: rl.quantity, reservedDelta: 0, referenceType: "PURCHASE_ORDER", referenceId: po.id,
        });
      }
      po.status = po.lines.every((l) => l.receivedQuantity === l.orderedQuantity) ? "RECEIVED" : "PARTIALLY_RECEIVED";
      state.receipts[receipt.id] = receipt;
      break;
    }

    case "INVENTORY_TRANSFERRED": {
      const t = structuredClone(event.payload.transfer);
      req(!state.inventoryTransfers[t.id], `duplicate transfer ${t.id}`);
      req(t.quantity > 0, "transfer quantity must be positive");
      req(t.fromLocationId !== t.toLocationId, "transfer needs different locations");
      location(t.fromLocationId);
      location(t.toLocationId);
      move(state, event, {
        locationId: t.fromLocationId, itemId: t.itemId, itemKind: t.itemKind, type: "TRANSFER_OUT",
        onHandDelta: -t.quantity, reservedDelta: 0, referenceType: "TRANSFER", referenceId: t.id,
      });
      move(state, event, {
        locationId: t.toLocationId, itemId: t.itemId, itemKind: t.itemKind, type: "TRANSFER_IN",
        onHandDelta: t.quantity, reservedDelta: 0, referenceType: "TRANSFER", referenceId: t.id,
      });
      state.inventoryTransfers[t.id] = t;
      break;
    }

    // ----- Sales ------------------------------------------------------------
    case "CUSTOMER_ORDER_CREATED": {
      const order = structuredClone(event.payload.customerOrder);
      req(!state.customerOrders[order.id], `duplicate customer order ${order.id}`);
      req(m.customers.has(order.customerId), `unknown customer ${order.customerId}`);
      req(order.status === "OPEN" && order.lines.length > 0, "new customer order must be OPEN with lines");
      for (const line of order.lines) {
        req(m.products.has(line.productId), `unknown product ${line.productId}`);
        req(line.quantity > 0 && line.allocatedQuantity === 0 && line.shippedQuantity === 0, "new line must be unallocated and unshipped");
      }
      state.customerOrders[order.id] = order;
      break;
    }

    case "CUSTOMER_ORDER_CANCELLED": {
      const order = getCustomerOrder(event.payload.customerOrderId);
      req(order.status === "OPEN", `cannot cancel customer order ${order.id} in status ${order.status}`);
      for (const line of order.lines) {
        if (line.allocatedQuantity > 0) {
          move(state, event, {
            locationId: m.products.get(line.productId)!.finishedGoodsLocationId, itemId: line.productId, itemKind: "FINISHED_GOOD",
            type: "FG_ALLOCATION_RELEASED", onHandDelta: 0, reservedDelta: -line.allocatedQuantity,
            referenceType: "CUSTOMER_ORDER", referenceId: order.id,
          });
          line.allocatedQuantity = 0;
        }
      }
      order.status = "CANCELLED";
      break;
    }

    // ----- Production -------------------------------------------------------
    case "PRODUCTION_ORDER_CREATED": {
      const order = structuredClone(event.payload.productionOrder);
      const ops = structuredClone(event.payload.operations);
      req(!state.productionOrders[order.id], `duplicate production order ${order.id}`);
      req(m.products.has(order.productId), `production order ${order.id} references unknown product ${order.productId}`);
      req(order.status === "PLANNED" && order.quantity > 0, "new production order must be PLANNED with quantity > 0");
      const routing = m.routingByProduct.get(order.productId);
      req(routing, `no routing for ${order.productId}`);
      req(ops.length === routing.steps.length, `order ${order.id} operations do not match routing length`);
      ops.forEach((op, i) => {
        const step = routing.steps[i];
        req(op.sequence === step.sequence && op.type === step.operationType && op.workstationKind === step.workstationKind,
          `operation ${op.id} deviates from routing ${routing.id}`);
        req(op.productionOrderId === order.id && op.status === "PENDING" && !op.isRework && op.quantity === order.quantity,
          `operation ${op.id} must be a PENDING routing step for the full order quantity`);
        req(!state.productionOperations[op.id], `duplicate operation ${op.id}`);
      });
      req(order.operationIds.length === ops.length && order.operationIds.every((id, i) => id === ops[i].id), "order.operationIds must list its operations in order");
      for (const op of ops) state.productionOperations[op.id] = op;
      state.productionOrders[order.id] = order;
      break;
    }

    case "PRODUCTION_ORDER_RELEASED": {
      const { productionOrderId, reservations } = event.payload;
      const order = getOrder(productionOrderId);
      req(
        order.status === "PLANNED" || (order.status === "BLOCKED" && order.blockReason === "MATERIAL_SHORTAGE"),
        `cannot release order ${order.id} in status ${order.status}`,
      );
      req(order.reservations.length === 0, `order ${order.id} already holds reservations`);
      const required = bomRequirements(m, order.productId, order.quantity);
      req(reservations.length === required.size, `reservations for ${order.id} do not cover the BOM`);
      for (const r of reservations) {
        req(required.get(r.materialId) === r.quantity, `reservation of ${r.materialId} must equal BOM requirement ${required.get(r.materialId)}`);
        req(location(r.locationId).kind === "RAW_STORAGE", "materials are reserved at raw storage");
        move(state, event, {
          locationId: r.locationId, itemId: r.materialId, itemKind: "RAW_MATERIAL", type: "RESERVATION",
          onHandDelta: 0, reservedDelta: r.quantity, referenceType: "PRODUCTION_ORDER", referenceId: order.id,
        });
      }
      order.reservations = structuredClone(reservations);
      order.status = "WAITING";
      order.releasedAt = ts;
      delete order.blockReason;
      delete order.blockedAt;
      refreshOrder(state, m, order);
      break;
    }

    case "PRODUCTION_ORDER_CANCELLED": {
      const order = getOrder(event.payload.productionOrderId);
      req(["PLANNED", "WAITING", "BLOCKED"].includes(order.status) && !order.materialsConsumed, `cannot cancel order ${order.id} (${order.status})`);
      req(!order.startedAt, "cannot cancel an order that has started");
      for (const r of order.reservations) {
        move(state, event, {
          locationId: r.locationId, itemId: r.materialId, itemKind: "RAW_MATERIAL", type: "RESERVATION_RELEASED",
          onHandDelta: 0, reservedDelta: -r.quantity, referenceType: "PRODUCTION_ORDER", referenceId: order.id,
        });
      }
      order.reservations = [];
      order.status = "CANCELLED";
      delete order.blockReason;
      delete order.blockedAt;
      refreshOrder(state, m, order);
      break;
    }

    case "PRODUCTION_BLOCKED": {
      const p = event.payload;
      const order = getOrder(p.productionOrderId);
      if (p.reason === "MATERIAL_SHORTAGE") {
        req(order.status === "PLANNED", `shortage can only block a PLANNED order, ${order.id} is ${order.status}`);
        req(p.shortages && p.shortages.length > 0, "shortage block must list the short materials");
        const required = bomRequirements(m, order.productId, order.quantity);
        for (const s of p.shortages) {
          const need = required.get(s.materialId);
          req(need !== undefined, `${s.materialId} is not in the BOM of ${order.productId}`);
          const available = Object.values(state.inventory)
            .filter((b) => b.itemId === s.materialId && location(b.locationId).kind === "RAW_STORAGE")
            .reduce((sum, b) => sum + availableOf(b), 0);
          req(s.required === need && s.available === available && available < need,
            `claimed shortage of ${s.materialId} does not match inventory (need ${need}, available ${available})`);
        }
      } else {
        req(order.status === "RUNNING", `machine block requires a RUNNING order, ${order.id} is ${order.status}`);
        req(p.operationId && p.workstationId && p.downtimeId, "machine block needs operation, workstation and downtime");
        const op = getOp(p.operationId);
        req(op.productionOrderId === order.id && op.status === "PAUSED", "machine block requires the operation to be PAUSED");
        req(getWs(p.workstationId).status === "DOWN", "machine block requires the workstation to be DOWN");
      }
      order.status = "BLOCKED";
      order.blockReason = p.reason;
      order.blockedAt = ts;
      refreshOrder(state, m, order);
      break;
    }

    case "PRODUCTION_RESUMED": {
      const p = event.payload;
      const order = getOrder(p.productionOrderId);
      req(order.status === "BLOCKED" && order.blockReason === "MACHINE_DOWN", `order ${order.id} is not blocked by a machine`);
      const op = getOp(p.operationId);
      const ws = getWs(p.workstationId);
      req(op.status === "PAUSED" && ws.pausedOperationId === op.id, "operation is not paused on that workstation");
      req(ws.status === "IDLE", `workstation ${ws.workstationId} is not restored`);
      op.status = "RUNNING";
      op.pausedMinutes += Math.round((Date.parse(ts) - Date.parse(op.pausedAt!)) / 60000);
      delete op.pausedAt;
      ws.status = "RUNNING";
      ws.currentOperationId = op.id;
      delete ws.pausedOperationId;
      ws.since = ts;
      order.status = "RUNNING";
      delete order.blockReason;
      delete order.blockedAt;
      refreshOrder(state, m, order);
      break;
    }

    case "MATERIAL_CONSUMED": {
      const { productionOrderId, consumptions } = event.payload;
      const order = getOrder(productionOrderId);
      req(order.status === "WAITING", `materials can only be consumed by a WAITING (released) order, ${order.id} is ${order.status}`);
      req(!order.materialsConsumed, `materials already consumed for ${order.id}`);
      req(consumptions.length === order.reservations.length, "consumption must cover every reservation");
      const required = bomRequirements(m, order.productId, order.quantity);
      for (const c of consumptions) {
        const r = order.reservations.find((x) => x.materialId === c.materialId);
        req(r, `${c.materialId} was never reserved for ${order.id}`);
        req(c.quantity === r.quantity && c.quantity === required.get(c.materialId), `consumption of ${c.materialId} must equal reservation and BOM requirement`);
        req(c.fromLocationId === r.locationId, "material must be consumed from where it is reserved");
        req(location(c.toLocationId).kind === "ASSEMBLY", "consumed material becomes WIP at an assembly workstation");
        move(state, event, {
          locationId: c.fromLocationId, itemId: c.materialId, itemKind: "RAW_MATERIAL", type: "CONSUMPTION",
          onHandDelta: -c.quantity, reservedDelta: -c.quantity, referenceType: "PRODUCTION_ORDER", referenceId: order.id,
        });
      }
      order.materialsConsumed = true;
      order.wipQuantity = order.quantity;
      break;
    }

    case "PRODUCTION_STARTED": {
      const p = event.payload;
      const order = getOrder(p.productionOrderId);
      const ws = getWs(p.workstationId);
      req(order.status === "WAITING", `cannot start order ${order.id} in status ${order.status}`);
      req(order.materialsConsumed, `order ${order.id} cannot start before its materials are consumed`);
      req(m.workstations.get(ws.workstationId)!.kind === "ASSEMBLY", "production starts on an assembly workstation");
      req(ws.status !== "DOWN", `workstation ${ws.workstationId} is down`);
      req(!state.workstationAssignments[p.assignmentId], `duplicate assignment ${p.assignmentId}`);
      state.workstationAssignments[p.assignmentId] = {
        id: p.assignmentId, productionOrderId: order.id, workstationId: ws.workstationId, assignedAt: ts,
      };
      order.status = "RUNNING";
      order.startedAt = ts;
      order.assignedWorkstationId = ws.workstationId;
      refreshOrder(state, m, order);
      break;
    }

    case "OPERATION_STARTED": {
      const p = event.payload;
      const order = getOrder(p.productionOrderId);
      const op = getOp(p.productionOperationId);
      const ws = getWs(p.workstationId);
      const wsMaster = m.workstations.get(ws.workstationId)!;
      req(op.productionOrderId === order.id, "operation does not belong to that order");
      req(order.status === "RUNNING", `order ${order.id} is ${order.status}, cannot start operations`);
      req(op.status === "PENDING", `operation ${op.id} is ${op.status}, not PENDING`);
      req(operationsOf(state, order).filter((o) => o.sequence < op.sequence).every((o) => o.status === "COMPLETED"),
        `operation ${op.id} started before its predecessors completed`);
      req(wsMaster.kind === op.workstationKind, `${op.type} cannot run on ${wsMaster.kind} workstation ${wsMaster.id}`);
      req(ws.status === "IDLE" && !ws.currentOperationId && !ws.pausedOperationId,
        `workstation ${ws.workstationId} is not free (capacity 1): ${ws.status}`);
      if (op.workstationKind === "ASSEMBLY") {
        req(order.assignedWorkstationId === ws.workstationId, "assembly operations run on the order's assigned workstation");
      }
      if (op.type === "FINAL_TEST") {
        req(order.productionCompletedAt && order.awaitingQcQuantity === op.quantity, "QC may only test units that finished production");
      }
      op.status = "RUNNING";
      op.workstationId = ws.workstationId;
      op.startedAt = ts;
      ws.status = "RUNNING";
      ws.currentOperationId = op.id;
      ws.since = ts;
      refreshOrder(state, m, order);
      break;
    }

    case "OPERATION_COMPLETED": {
      const p = event.payload;
      const order = getOrder(p.productionOrderId);
      const op = getOp(p.productionOperationId);
      const ws = getWs(p.workstationId);
      req(op.status === "RUNNING" && op.workstationId === ws.workstationId && ws.currentOperationId === op.id,
        `operation ${op.id} is not running on ${ws.workstationId}`);
      if (op.type === "FINAL_TEST") {
        req(order.inspectionIds.some((id) => state.qualityInspections[id].operationId === op.id), "QC operation completed without an inspection record");
      }
      op.status = "COMPLETED";
      op.completedAt = ts;
      ws.status = "IDLE";
      delete ws.currentOperationId;
      ws.since = ts;
      if (op.isRework) {
        order.awaitingQcQuantity = op.quantity;
        order.reworkPendingQuantity -= op.quantity;
        req(order.reworkPendingQuantity >= 0, "rework quantity underflow");
      }
      refreshOrder(state, m, order);
      break;
    }

    case "PRODUCTION_COMPLETED": {
      const p = event.payload;
      const order = getOrder(p.productionOrderId);
      req(order.status === "RUNNING" && !order.productionCompletedAt, `order ${order.id} cannot complete production now`);
      req(p.workstationId === order.assignedWorkstationId, "production completes on the assigned workstation");
      const assemblyOps = operationsOf(state, order).filter((o) => ASSEMBLY_TYPES.has(o.type));
      req(assemblyOps.length > 0 && assemblyOps.every((o) => o.status === "COMPLETED"), "assembly operations are not all completed");
      req(p.quantityProduced === order.quantity, "produced quantity must equal order quantity");
      order.productionCompletedAt = ts;
      order.awaitingQcQuantity = order.quantity;
      refreshOrder(state, m, order);
      break;
    }

    case "QUALITY_INSPECTION_COMPLETED": {
      const insp = structuredClone(event.payload.inspection);
      const order = getOrder(insp.productionOrderId);
      const op = getOp(insp.operationId);
      req(!state.qualityInspections[insp.id], `duplicate inspection ${insp.id}`);
      req(op.type === "FINAL_TEST" && op.status === "RUNNING" && op.workstationId === insp.workstationId, "inspection must come from a running FINAL_TEST operation");
      req(order.productionCompletedAt, "units cannot be inspected before production completes");
      req(insp.inspectedQuantity === order.awaitingQcQuantity && insp.inspectedQuantity === op.quantity, "inspected quantity must equal units awaiting QC");
      req(insp.passedQuantity + insp.failedQuantity === insp.inspectedQuantity, "passed + failed must equal inspected");
      req(insp.reworkQuantity + insp.scrapQuantity === insp.failedQuantity, "rework + scrap must equal failed");
      req(insp.defects.reduce((s, d) => s + d.quantity, 0) === insp.failedQuantity, "defect counts must equal failed units");
      req(insp.round === order.inspectionIds.length + 1, "inspection round out of sequence");
      req(insp.round === 1 || insp.reworkQuantity === 0, "units failing re-inspection are scrapped, not reworked twice");
      state.qualityInspections[insp.id] = insp;
      order.inspectionIds.push(insp.id);
      order.awaitingQcQuantity = 0;
      order.approvedQuantity += insp.passedQuantity;
      order.scrappedQuantity += insp.scrapQuantity;
      order.wipQuantity -= insp.scrapQuantity;
      order.reworkPendingQuantity = insp.reworkQuantity;
      break;
    }

    case "REWORK_REQUESTED": {
      const p = event.payload;
      const order = getOrder(p.productionOrderId);
      const insp = state.qualityInspections[p.inspectionId];
      req(insp && insp.productionOrderId === order.id, "rework must reference an inspection of this order");
      req(insp.reworkQuantity === p.quantity && order.reworkPendingQuantity === p.quantity && p.quantity > 0, "rework quantity must match the failed inspection");
      req(p.operations.length === 2, "rework adds a REWORK and a FINAL_TEST operation");
      const lastSeq = Math.max(...operationsOf(state, order).map((o) => o.sequence));
      const [rework, retest] = structuredClone(p.operations);
      req(rework.type === "REWORK" && rework.isRework && rework.workstationKind === "ASSEMBLY" && rework.sequence > lastSeq, "invalid rework operation");
      req(retest.type === "FINAL_TEST" && retest.workstationKind === "INSPECTION" && retest.sequence > rework.sequence, "invalid retest operation");
      for (const op of [rework, retest]) {
        req(op.productionOrderId === order.id && op.status === "PENDING" && op.quantity === p.quantity, "rework operations must be PENDING for the rework quantity");
        req(!state.productionOperations[op.id], `duplicate operation ${op.id}`);
        state.productionOperations[op.id] = op;
        order.operationIds.push(op.id);
      }
      refreshOrder(state, m, order);
      break;
    }

    case "FINISHED_GOODS_RECEIVED": {
      const p = event.payload;
      const order = getOrder(p.productionOrderId);
      req(order.status === "RUNNING" && order.productionCompletedAt, `order ${order.id} has not completed production`);
      req(operationsOf(state, order).every((o) => o.status === "COMPLETED"), "cannot receive goods while operations are outstanding");
      req(order.awaitingQcQuantity === 0 && order.reworkPendingQuantity === 0, "units are still awaiting QC or rework");
      req(order.inspectionIds.length > 0, "finished goods require an approved inspection");
      req(p.productId === order.productId, "product mismatch");
      req(p.quantity === order.approvedQuantity - order.finishedGoodsReceivedQuantity, `only QC-approved units may be received (approved ${order.approvedQuantity})`);
      req(p.locationId === m.products.get(order.productId)!.finishedGoodsLocationId, "finished goods go to the product's FG location");
      if (p.quantity > 0) {
        move(state, event, {
          locationId: p.locationId, itemId: p.productId, itemKind: "FINISHED_GOOD", type: "FG_RECEIPT",
          onHandDelta: p.quantity, reservedDelta: 0, referenceType: "PRODUCTION_ORDER", referenceId: order.id,
        });
      }
      order.finishedGoodsReceivedQuantity += p.quantity;
      order.wipQuantity -= p.quantity;
      req(order.wipQuantity === 0, `order ${order.id} closes with ${order.wipQuantity} units unaccounted for`);
      order.status = "COMPLETED";
      order.completedAt = ts;
      const assignment = Object.values(state.workstationAssignments).find((a) => a.productionOrderId === order.id);
      if (assignment) assignment.releasedAt = ts;
      refreshOrder(state, m, order);
      break;
    }

    // ----- Finished goods & shipping ----------------------------------------
    case "FINISHED_GOODS_ALLOCATED": {
      const p = event.payload;
      const order = getCustomerOrder(p.customerOrderId);
      req(order.status === "OPEN" || order.status === "PARTIALLY_SHIPPED", `customer order ${order.id} is ${order.status}`);
      const line = order.lines.find((l) => l.id === p.customerOrderLineId);
      req(line && line.productId === p.productId, "allocation line/product mismatch");
      req(p.quantity > 0, "allocation must be positive");
      req(p.quantity <= line.quantity - line.allocatedQuantity - line.shippedQuantity, `allocation exceeds open quantity of ${line.id}`);
      req(p.locationId === m.products.get(p.productId)!.finishedGoodsLocationId, "allocate from the product's FG location");
      move(state, event, {
        locationId: p.locationId, itemId: p.productId, itemKind: "FINISHED_GOOD", type: "FG_ALLOCATION",
        onHandDelta: 0, reservedDelta: p.quantity, referenceType: "CUSTOMER_ORDER", referenceId: order.id,
      });
      line.allocatedQuantity += p.quantity;
      break;
    }

    case "SHIPMENT_DISPATCHED": {
      const shipment = structuredClone(event.payload.shipment);
      req(!state.shipments[shipment.id], `duplicate shipment ${shipment.id}`);
      const order = getCustomerOrder(shipment.customerOrderId);
      req(order.status === "OPEN" || order.status === "PARTIALLY_SHIPPED", `customer order ${order.id} is ${order.status}`);
      req(order.customerId === shipment.customerId, "shipment customer does not match order");
      req(shipment.lines.length > 0, "empty shipment");
      for (const sl of shipment.lines) {
        const line = order.lines.find((l) => l.id === sl.customerOrderLineId);
        req(line && line.productId === sl.productId, "shipment line does not match order line");
        req(sl.quantity > 0 && sl.quantity <= line.allocatedQuantity, `shipment of ${sl.quantity} exceeds ${line.allocatedQuantity} allocated on ${line.id}`);
        req(sl.fromLocationId === m.products.get(sl.productId)!.finishedGoodsLocationId, "ship from the FG location");
        move(state, event, {
          locationId: sl.fromLocationId, itemId: sl.productId, itemKind: "FINISHED_GOOD", type: "SHIPMENT",
          onHandDelta: -sl.quantity, reservedDelta: -sl.quantity, referenceType: "SHIPMENT", referenceId: shipment.id,
        });
        line.allocatedQuantity -= sl.quantity;
        line.shippedQuantity += sl.quantity;
      }
      order.status = order.lines.every((l) => l.shippedQuantity === l.quantity) ? "SHIPPED" : "PARTIALLY_SHIPPED";
      state.shipments[shipment.id] = shipment;
      break;
    }

    // ----- Machines ---------------------------------------------------------
    case "MACHINE_FAILED": {
      const p = event.payload;
      const ws = getWs(p.workstationId);
      req(ws.status !== "DOWN", `workstation ${ws.workstationId} is already down`);
      req(!state.downtimes[p.downtimeId], `duplicate downtime ${p.downtimeId}`);
      state.downtimes[p.downtimeId] = {
        id: p.downtimeId, workstationId: ws.workstationId, failureCode: p.failureCode, failedAt: ts, expectedRepairMinutes: p.expectedRepairMinutes,
      };
      if (ws.currentOperationId) {
        const op = getOp(ws.currentOperationId);
        op.status = "PAUSED";
        op.pausedAt = ts;
        op.interruptedByDowntimeIds.push(p.downtimeId);
        ws.pausedOperationId = op.id;
        delete ws.currentOperationId;
      }
      ws.status = "DOWN";
      ws.since = ts;
      break;
    }

    case "MACHINE_RESTORED": {
      const p = event.payload;
      const ws = getWs(p.workstationId);
      const dt = state.downtimes[p.downtimeId];
      req(dt && dt.workstationId === ws.workstationId && !dt.restoredAt, "unknown or already restored downtime");
      req(ws.status === "DOWN", `workstation ${ws.workstationId} is not down`);
      dt.restoredAt = ts;
      ws.status = "IDLE";
      ws.since = ts;
      break;
    }

    default: {
      const never: never = event;
      throw new InvariantViolation(`unhandled event type ${(never as FactoryEvent).type}`);
    }
  }

  state.lastSequence = event.sequence;
  state.asOf = ts;
}

/** Replay events onto a copy of `initial`; reports the first rejected event instead of throwing. */
export function replayWithGuard(
  master: MasterData,
  initial: FactoryState,
  events: FactoryEvent[],
): { state: FactoryState; error?: string } {
  const state = structuredClone(initial);
  for (const event of events) {
    try {
      applyEventInPlace(state, event, master);
    } catch (err) {
      return { state, error: `${event.id} (${event.type}): ${(err as Error).message}` };
    }
  }
  return { state };
}
