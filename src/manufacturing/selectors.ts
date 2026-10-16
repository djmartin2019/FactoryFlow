/**
 * Read-only views over FactoryState shaped for the dashboard features
 * (inventory per location, station status, WIP, shortages, fulfilment).
 */
import type { OperationalStatus } from "../graphics/FactoryObject.ts";
import { MIN, shiftMinutesBetween } from "./calendar.ts";
import { availableOf } from "./state.ts";
import type { FactoryState, Id, IsoTimestamp, MasterData, ProductionOperation, ProductionStage } from "./types.ts";

export interface LocationInventoryItem {
  itemId: Id;
  itemKind: "RAW_MATERIAL" | "FINISHED_GOOD";
  onHand: number;
  reserved: number;
  available: number;
}

export interface LocationInventory {
  locationId: Id;
  items: LocationInventoryItem[];
  palletsUsed: number;
  palletCapacity: number;
  /** palletsUsed / palletCapacity, 0..1+ (can exceed 1 if over-full). */
  utilization: number;
}

export function inventoryByLocation(state: FactoryState, master: MasterData): Record<Id, LocationInventory> {
  const perPallet = new Map<Id, number>([
    ...master.materials.map((m) => [m.id, m.unitsPerPallet] as const),
    ...master.products.map((p) => [p.id, p.unitsPerPallet] as const),
  ]);
  const result: Record<Id, LocationInventory> = {};
  for (const loc of master.locations) {
    result[loc.id] = { locationId: loc.id, items: [], palletsUsed: 0, palletCapacity: loc.palletCapacity, utilization: 0 };
  }
  for (const b of Object.values(state.inventory)) {
    if (b.onHand === 0) continue;
    const entry = result[b.locationId];
    entry.items.push({ itemId: b.itemId, itemKind: b.itemKind, onHand: b.onHand, reserved: b.reserved, available: availableOf(b) });
    entry.palletsUsed += Math.ceil(b.onHand / (perPallet.get(b.itemId) ?? 1));
  }
  for (const e of Object.values(result)) e.utilization = e.palletCapacity > 0 ? e.palletsUsed / e.palletCapacity : 0;
  return result;
}

export interface ReadyOperation {
  operation: ProductionOperation;
  productionOrderId: Id;
  /** Work center that must run it; undefined for pre-1.1.0 data. */
  workCenterId?: Id;
  /** Since when it has been able to start: previous step completed, or order release for the first step. */
  readySince?: IsoTimestamp;
}

/**
 * Operations that could start now if a station were free: PENDING, predecessors complete, order on the floor
 * (WAITING for its first step, RUNNING otherwise). This is the queue in front of each work center.
 */
export function readyOperations(state: FactoryState): ReadyOperation[] {
  const out: ReadyOperation[] = [];
  for (const o of Object.values(state.productionOrders)) {
    if (o.status !== "WAITING" && o.status !== "RUNNING") continue;
    const ops = o.operationIds.map((id) => state.productionOperations[id]);
    const next = ops.find((op) => op.status !== "COMPLETED");
    if (!next || next.status !== "PENDING") continue;
    if (o.status === "WAITING" && next !== ops[0]) continue;
    const prev = ops[ops.indexOf(next) - 1];
    out.push({
      operation: next,
      productionOrderId: o.id,
      workCenterId: next.workCenterId,
      readySince: prev ? prev.completedAt : o.releasedAt,
    });
  }
  return out;
}

export interface WorkstationView {
  workstationId: Id;
  runStatus: "IDLE" | "RUNNING" | "DOWN";
  /** Maps onto the existing FactoryObject status colours. `blocked` = idle while orders wait on material. */
  objectStatus: OperationalStatus;
  currentOrderId?: Id;
  queuedOrderIds: Id[];
  /** Busy time / scheduled shift time over the trailing window, 0..1. */
  utilization: number;
}

export function workstationViews(state: FactoryState, master: MasterData, windowHours = 24): WorkstationView[] {
  const now = Date.parse(state.asOf);
  const from = now - windowHours * 60 * MIN;
  const shiftMinutes = shiftMinutesBetween(from, now);
  const anyShortage = Object.values(state.productionOrders).some((o) => o.status === "BLOCKED" && o.blockReason === "MATERIAL_SHORTAGE");

  const ready = readyOperations(state);
  return master.workstations.map((ws) => {
    const rt = state.workstations[ws.id];
    const ops = Object.values(state.productionOperations).filter((o) => o.workstationId === ws.id && o.startedAt);
    let busy = 0;
    for (const op of ops) {
      const s = Math.max(from, Date.parse(op.startedAt!));
      const e = Math.min(now, op.completedAt ? Date.parse(op.completedAt) : now);
      if (e > s) busy += (e - s) / MIN;
    }
    const currentOp = rt.currentOperationId ? state.productionOperations[rt.currentOperationId] : undefined;
    // Queue = orders whose next step belongs to a work center this station serves.
    const served = new Set(ws.workCenterIds ?? []);
    const queued = ready
      .filter((r) => r.operation.workstationKind === "ASSEMBLY" && ws.kind === "ASSEMBLY" && (served.size === 0 || !r.workCenterId || served.has(r.workCenterId)))
      .map((r) => r.productionOrderId);
    const waitingQc =
      ws.kind === "INSPECTION"
        ? Object.values(state.productionOrders).filter((o) => o.stage === "AWAITING_QC").map((o) => o.id)
        : [];
    const objectStatus: OperationalStatus =
      rt.status === "DOWN" ? "down" : rt.status === "RUNNING" ? "running" : anyShortage && ws.kind === "ASSEMBLY" && queued.length === 0 ? "blocked" : "idle";
    return {
      workstationId: ws.id,
      runStatus: rt.status,
      objectStatus,
      currentOrderId: currentOp?.productionOrderId,
      queuedOrderIds: ws.kind === "ASSEMBLY" ? queued : waitingQc,
      utilization: shiftMinutes > 0 ? Math.min(1, busy / shiftMinutes) : 0,
    };
  });
}

export interface WipSummary {
  locationId: Id;
  orderIds: Id[];
  units: number;
  byStage: Partial<Record<ProductionStage, number>>;
}

/** WIP units grouped by the location (workstation / QC cell) they sit at. */
export function wipByLocation(state: FactoryState): Record<Id, WipSummary> {
  const out: Record<Id, WipSummary> = {};
  for (const o of Object.values(state.productionOrders)) {
    if (o.wipQuantity <= 0 || !o.currentLocationId) continue;
    const entry = (out[o.currentLocationId] ??= { locationId: o.currentLocationId, orderIds: [], units: 0, byStage: {} });
    entry.orderIds.push(o.id);
    entry.units += o.wipQuantity;
    entry.byStage[o.stage] = (entry.byStage[o.stage] ?? 0) + o.wipQuantity;
  }
  return out;
}

export interface ShortageView {
  materialId: Id;
  /** Blocked production orders waiting on this material. */
  productionOrderIds: Id[];
  openPurchaseOrderIds: Id[];
}

/** Materials currently holding production orders in BLOCKED(MATERIAL_SHORTAGE). */
export function materialShortages(state: FactoryState, master: MasterData): ShortageView[] {
  const byMaterial = new Map<Id, Set<Id>>();
  for (const o of Object.values(state.productionOrders)) {
    if (o.status !== "BLOCKED" || o.blockReason !== "MATERIAL_SHORTAGE") continue;
    const bom = master.billsOfMaterials.find((b) => b.productId === o.productId)!;
    for (const line of bom.lines) {
      const need = line.quantityPer * o.quantity;
      const available = Object.values(state.inventory)
        .filter((b) => b.itemId === line.materialId && master.locations.find((l) => l.id === b.locationId)?.kind === "RAW_STORAGE")
        .reduce((s, b) => s + availableOf(b), 0);
      if (available < need) {
        if (!byMaterial.has(line.materialId)) byMaterial.set(line.materialId, new Set());
        byMaterial.get(line.materialId)!.add(o.id);
      }
    }
  }
  return [...byMaterial.entries()].map(([materialId, orders]) => ({
    materialId,
    productionOrderIds: [...orders],
    openPurchaseOrderIds: Object.values(state.purchaseOrders)
      .filter((po) => po.status !== "RECEIVED" && po.lines.some((l) => l.materialId === materialId && l.receivedQuantity < l.orderedQuantity))
      .map((po) => po.id),
  }));
}

export interface CustomerOrderProgress {
  orderId: Id;
  status: string;
  ordered: number;
  allocated: number;
  shipped: number;
  fulfilment: number;
}

export function customerOrderProgress(state: FactoryState): CustomerOrderProgress[] {
  return Object.values(state.customerOrders).map((o) => {
    const ordered = o.lines.reduce((s, l) => s + l.quantity, 0);
    const shipped = o.lines.reduce((s, l) => s + l.shippedQuantity, 0);
    const allocated = o.lines.reduce((s, l) => s + l.allocatedQuantity, 0);
    return { orderId: o.id, status: o.status, ordered, allocated, shipped, fulfilment: ordered ? shipped / ordered : 0 };
  });
}
