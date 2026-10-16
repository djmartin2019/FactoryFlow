/**
 * Independent dataset validation. The reducer already rejects impossible
 * transitions while events are applied; these checks re-derive the same
 * guarantees from the finished tables so a corrupted or hand-edited dataset
 * is caught too.
 */
import { inShift } from "./calendar.ts";
import { eventIdFor } from "./events.ts";
import { indexMaster, inventoryKey, replayWithGuard } from "./state.ts";
import type { FactoryEvent, FactoryState, Id, ManufacturingDataset, ProductionOperation } from "./types.ts";

export interface ValidationCheck {
  name: string;
  problems: string[];
}

export interface ValidationReport {
  ok: boolean;
  checks: ValidationCheck[];
  problemCount: number;
}

const MAX_PROBLEMS_PER_CHECK = 25;

function normalize<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => k in (b as object) && deepEqual((a as any)[k], (b as any)[k]));
}

function findFirstDifference(a: any, b: any, path = ""): string | undefined {
  if (deepEqual(a, b)) return undefined;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = findFirstDifference(a[k], b[k], `${path}/${k}`);
    if (d) return d;
  }
  return path;
}

function duplicates(ids: Id[]): Id[] {
  const seen = new Set<Id>();
  const dup = new Set<Id>();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return [...dup];
}

export function validateDataset(dataset: ManufacturingDataset): ValidationReport {
  const { master, initialState, events, finalState: fs } = dataset;
  const m = indexMaster(master);
  const checks: ValidationCheck[] = [];
  const check = (name: string, fn: (problem: (msg: string) => void) => void) => {
    const problems: string[] = [];
    try {
      fn((msg) => {
        if (problems.length < MAX_PROBLEMS_PER_CHECK) problems.push(msg);
      });
    } catch (err) {
      problems.push(`check crashed: ${(err as Error).message}`);
    }
    checks.push({ name, problems });
  };

  const orders = Object.values(fs.productionOrders);
  const ops = Object.values(fs.productionOperations);

  check("event ordering (sequence, timestamps, ids)", (bad) => {
    let prevTs = -Infinity;
    events.forEach((e, i) => {
      if (e.sequence !== i + 1) bad(`event at index ${i} has sequence ${e.sequence}`);
      if (e.id !== eventIdFor(e.sequence)) bad(`event ${e.id} id does not match sequence ${e.sequence}`);
      const t = Date.parse(e.timestamp);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(e.timestamp)) bad(`${e.id} timestamp is not ISO 8601 UTC`);
      if (t < prevTs) bad(`${e.id} goes back in time (${e.timestamp})`);
      prevTs = t;
    });
    for (const d of duplicates(events.map((e) => e.id))) bad(`duplicate event id ${d}`);
  });

  check("no duplicate ids", (bad) => {
    const tables: Record<string, Id[]> = {
      purchaseOrders: Object.values(fs.purchaseOrders).map((x) => x.id),
      purchaseOrderLines: Object.values(fs.purchaseOrders).flatMap((p) => p.lines.map((l) => l.id)),
      receipts: Object.values(fs.receipts).map((x) => x.id),
      receiptLines: Object.values(fs.receipts).flatMap((r) => r.lines.map((l) => l.id)),
      transactions: fs.inventoryTransactions.map((x) => x.id),
      productionOrders: orders.map((x) => x.id),
      operations: ops.map((x) => x.id),
      inspections: Object.values(fs.qualityInspections).map((x) => x.id),
      customerOrders: Object.values(fs.customerOrders).map((x) => x.id),
      customerOrderLines: Object.values(fs.customerOrders).flatMap((o) => o.lines.map((l) => l.id)),
      shipments: Object.values(fs.shipments).map((x) => x.id),
      shipmentLines: Object.values(fs.shipments).flatMap((s) => s.lines.map((l) => l.id)),
      assignments: Object.values(fs.workstationAssignments).map((x) => x.id),
    };
    for (const [name, ids] of Object.entries(tables)) for (const d of duplicates(ids)) bad(`${name}: duplicate id ${d}`);
  });

  check("referential integrity", (bad) => {
    for (const po of Object.values(fs.purchaseOrders)) {
      if (!m.suppliers.has(po.supplierId)) bad(`${po.id}: unknown supplier ${po.supplierId}`);
      for (const l of po.lines) if (!m.materials.has(l.materialId)) bad(`${l.id}: unknown material`);
    }
    for (const r of Object.values(fs.receipts)) {
      const po = fs.purchaseOrders[r.purchaseOrderId];
      if (!po) { bad(`${r.id}: unknown PO ${r.purchaseOrderId}`); continue; }
      for (const l of r.lines) if (!po.lines.some((pl) => pl.id === l.purchaseOrderLineId)) bad(`${r.id}: unknown PO line ${l.purchaseOrderLineId}`);
    }
    for (const o of orders) {
      if (!m.products.has(o.productId)) bad(`${o.id}: unknown product ${o.productId}`);
      if (o.assignedWorkstationId && !m.workstations.has(o.assignedWorkstationId)) bad(`${o.id}: unknown workstation`);
      if (o.status !== "PLANNED" && o.status !== "CANCELLED" && !(o.status === "BLOCKED" && !o.releasedAt) && o.status !== "WAITING" && !o.assignedWorkstationId) {
        bad(`${o.id}: ${o.status} but no workstation assignment`);
      }
      for (const lineId of o.demandLineIds) {
        if (!Object.values(fs.customerOrders).some((c) => c.lines.some((l) => l.id === lineId))) bad(`${o.id}: unknown demand line ${lineId}`);
      }
    }
    // Every work center a routing needs must have a station, otherwise orders would stall forever.
    for (const r of master.routings) {
      for (const step of r.steps) {
        if (!step.workCenterId) continue;
        if (!master.workstations.some((w) => w.workCenterIds?.includes(step.workCenterId!))) {
          bad(`${r.id}: no workstation serves ${step.workCenterId}`);
        }
      }
    }
    for (const op of ops) {
      if (!fs.productionOrders[op.productionOrderId]) bad(`${op.id}: unknown order`);
      if (op.workstationId && !m.workstations.has(op.workstationId)) bad(`${op.id}: unknown workstation`);
      const served = op.workstationId ? m.workstations.get(op.workstationId)?.workCenterIds : undefined;
      if (op.workCenterId && served && !served.includes(op.workCenterId)) {
        bad(`${op.id}: ran on ${op.workstationId}, which does not serve ${op.workCenterId}`);
      }
    }
    for (const q of Object.values(fs.qualityInspections)) {
      if (!fs.productionOrders[q.productionOrderId] || !fs.productionOperations[q.operationId]) bad(`${q.id}: dangling reference`);
    }
    for (const c of Object.values(fs.customerOrders)) {
      if (!m.customers.has(c.customerId)) bad(`${c.id}: unknown customer`);
      for (const l of c.lines) if (!m.products.has(l.productId)) bad(`${l.id}: unknown product`);
    }
    for (const s of Object.values(fs.shipments)) {
      const order = fs.customerOrders[s.customerOrderId];
      if (!order) { bad(`${s.id}: unknown customer order`); continue; }
      for (const l of s.lines) if (!order.lines.some((x) => x.id === l.customerOrderLineId)) bad(`${s.id}: unknown order line ${l.customerOrderLineId}`);
    }
    for (const t of fs.inventoryTransactions) {
      if (!m.locations.has(t.locationId)) bad(`${t.id}: unknown location`);
      if (!m.materials.has(t.itemId) && !m.products.has(t.itemId)) bad(`${t.id}: unknown item`);
    }
  });

  check("BOM material requirements", (bad) => {
    const consumed = new Map<Id, Map<Id, number>>();
    for (const e of events) {
      if (e.type !== "MATERIAL_CONSUMED") continue;
      if (consumed.has(e.payload.productionOrderId)) bad(`${e.payload.productionOrderId}: materials consumed twice`);
      consumed.set(e.payload.productionOrderId, new Map(e.payload.consumptions.map((c) => [c.materialId, c.quantity])));
    }
    for (const o of orders) {
      const c = consumed.get(o.id);
      if (!o.startedAt) {
        if (c) bad(`${o.id}: consumed material but never started`);
        continue;
      }
      if (!c) { bad(`${o.id}: started without consuming material`); continue; }
      const bom = m.bomByProduct.get(o.productId)!;
      if (c.size !== bom.lines.length) bad(`${o.id}: consumed ${c.size} materials, BOM has ${bom.lines.length}`);
      for (const line of bom.lines) {
        if (c.get(line.materialId) !== line.quantityPer * o.quantity) {
          bad(`${o.id}: ${line.materialId} consumed ${c.get(line.materialId)}, BOM requires ${line.quantityPer * o.quantity}`);
        }
      }
    }
  });

  check("inventory reconciles with transactions (and is never negative)", (bad) => {
    const expected = new Map<string, { onHand: number; reserved: number }>();
    for (const b of Object.values(initialState.inventory)) expected.set(inventoryKey(b.locationId, b.itemId), { onHand: b.onHand, reserved: b.reserved });
    for (const t of fs.inventoryTransactions) {
      const k = inventoryKey(t.locationId, t.itemId);
      const e = expected.get(k) ?? { onHand: 0, reserved: 0 };
      e.onHand += t.onHandDelta;
      e.reserved += t.reservedDelta;
      expected.set(k, e);
    }
    const keys = new Set([...expected.keys(), ...Object.keys(fs.inventory)]);
    for (const k of keys) {
      const e = expected.get(k) ?? { onHand: 0, reserved: 0 };
      const f = fs.inventory[k] ?? { onHand: 0, reserved: 0 };
      if (e.onHand !== f.onHand || e.reserved !== f.reserved) bad(`${k}: transactions give ${JSON.stringify(e)}, balance is ${JSON.stringify(f)}`);
      if (f.onHand < 0 || f.reserved < 0 || f.reserved > f.onHand) bad(`${k}: invalid balance ${JSON.stringify(f)}`);
    }
    // Every intermediate step too: running balance from the ordered transaction log.
    const running = new Map<string, { onHand: number; reserved: number }>();
    for (const [k, v] of Object.entries(initialState.inventory)) running.set(k, { onHand: v.onHand, reserved: v.reserved });
    for (const t of fs.inventoryTransactions) {
      const k = inventoryKey(t.locationId, t.itemId);
      const r = running.get(k) ?? { onHand: 0, reserved: 0 };
      r.onHand += t.onHandDelta;
      r.reserved += t.reservedDelta;
      running.set(k, r);
      if (r.onHand < 0 || r.reserved < 0 || r.reserved > r.onHand) bad(`${t.id}: ${k} available went negative (${JSON.stringify(r)})`);
    }
  });

  check("raw material conservation per material", (bad) => {
    for (const mat of master.materials) {
      const sum = (s: FactoryState) =>
        Object.values(s.inventory).filter((b) => b.itemId === mat.id).reduce((x, b) => x + b.onHand, 0);
      const received = Object.values(fs.receipts).flatMap((r) => r.lines).filter((l) => l.materialId === mat.id).reduce((x, l) => x + l.quantity, 0);
      const consumed = orders
        .filter((o) => o.materialsConsumed)
        .reduce((x, o) => x + (m.bomByProduct.get(o.productId)!.lines.find((l) => l.materialId === mat.id)?.quantityPer ?? 0) * o.quantity, 0);
      if (sum(initialState) + received - consumed !== sum(fs)) bad(`${mat.id}: opening + received - consumed != on hand`);
    }
  });

  check("production state transitions", (bad) => {
    type S = "PLANNED" | "BLOCKED_MAT" | "WAITING" | "RUNNING" | "BLOCKED_MCH" | "COMPLETED" | "CANCELLED";
    const status = new Map<Id, S>();
    const need = (e: FactoryEvent, id: Id, allowed: S[]) => {
      const s = status.get(id);
      if (!s || !allowed.includes(s)) bad(`${e.id} ${e.type}: ${id} is ${s ?? "unknown"}, expected ${allowed.join("|")}`);
    };
    for (const e of events) {
      switch (e.type) {
        case "PRODUCTION_ORDER_CREATED":
          if (status.has(e.payload.productionOrder.id)) bad(`${e.id}: order recreated`);
          status.set(e.payload.productionOrder.id, "PLANNED");
          break;
        case "PRODUCTION_BLOCKED":
          if (e.payload.reason === "MATERIAL_SHORTAGE") { need(e, e.payload.productionOrderId, ["PLANNED"]); status.set(e.payload.productionOrderId, "BLOCKED_MAT"); }
          else { need(e, e.payload.productionOrderId, ["RUNNING"]); status.set(e.payload.productionOrderId, "BLOCKED_MCH"); }
          break;
        case "PRODUCTION_ORDER_RELEASED":
          need(e, e.payload.productionOrderId, ["PLANNED", "BLOCKED_MAT"]);
          status.set(e.payload.productionOrderId, "WAITING");
          break;
        case "PRODUCTION_ORDER_CANCELLED":
          need(e, e.payload.productionOrderId, ["PLANNED", "BLOCKED_MAT", "WAITING"]);
          status.set(e.payload.productionOrderId, "CANCELLED");
          break;
        case "MATERIAL_CONSUMED":
          need(e, e.payload.productionOrderId, ["WAITING"]);
          break;
        case "PRODUCTION_STARTED":
          need(e, e.payload.productionOrderId, ["WAITING"]);
          status.set(e.payload.productionOrderId, "RUNNING");
          break;
        case "PRODUCTION_RESUMED":
          need(e, e.payload.productionOrderId, ["BLOCKED_MCH"]);
          status.set(e.payload.productionOrderId, "RUNNING");
          break;
        case "OPERATION_STARTED":
        case "OPERATION_COMPLETED":
        case "PRODUCTION_COMPLETED":
        case "REWORK_REQUESTED":
          need(e, e.payload.productionOrderId, ["RUNNING"]);
          break;
        case "QUALITY_INSPECTION_COMPLETED":
          need(e, e.payload.inspection.productionOrderId, ["RUNNING"]);
          break;
        case "FINISHED_GOODS_RECEIVED":
          need(e, e.payload.productionOrderId, ["RUNNING"]);
          status.set(e.payload.productionOrderId, "COMPLETED");
          break;
        default:
          break;
      }
    }
    for (const o of orders) {
      const expected: Record<string, S[]> = {
        PLANNED: ["PLANNED"], WAITING: ["WAITING"], RUNNING: ["RUNNING"],
        BLOCKED: ["BLOCKED_MAT", "BLOCKED_MCH"], COMPLETED: ["COMPLETED"], CANCELLED: ["CANCELLED"],
      };
      if (!expected[o.status].includes(status.get(o.id)!)) bad(`${o.id}: final status ${o.status} disagrees with event history (${status.get(o.id)})`);
    }
  });

  check("operations follow routing and timing", (bad) => {
    for (const o of orders) {
      const routing = m.routingByProduct.get(o.productId)!;
      const own = o.operationIds.map((id) => fs.productionOperations[id]);
      routing.steps.forEach((step, i) => {
        const op = own[i];
        if (!op || op.type !== step.operationType || op.sequence !== step.sequence) bad(`${o.id}: operation ${i} deviates from routing ${routing.id}`);
      });
      const timed = own.filter((x) => x.startedAt);
      for (let i = 1; i < timed.length; i++) {
        const prev = timed[i - 1];
        if (!prev.completedAt || Date.parse(timed[i].startedAt!) < Date.parse(prev.completedAt)) bad(`${o.id}: ${timed[i].id} started before ${prev.id} completed`);
      }
      if (o.startedAt && o.productionCompletedAt && Date.parse(o.startedAt) >= Date.parse(o.productionCompletedAt)) bad(`${o.id}: start does not precede production completion`);
      if (o.productionCompletedAt && o.completedAt && Date.parse(o.productionCompletedAt) > Date.parse(o.completedAt)) bad(`${o.id}: production completed after order completed`);
      if (o.startedAt && !inShift(Date.parse(o.startedAt))) bad(`${o.id}: started outside shift (${o.startedAt})`);
    }
    for (const op of ops) {
      if (op.startedAt && op.completedAt && Date.parse(op.startedAt) >= Date.parse(op.completedAt)) bad(`${op.id}: start does not precede completion`);
      if (op.status === "COMPLETED" && (!op.startedAt || !op.completedAt)) bad(`${op.id}: COMPLETED without timestamps`);
    }
  });

  check("workstation capacity (one job at a time)", (bad) => {
    const byStation = new Map<Id, ProductionOperation[]>();
    for (const op of ops) if (op.workstationId && op.startedAt) (byStation.get(op.workstationId) ?? byStation.set(op.workstationId, []).get(op.workstationId)!).push(op);
    const end = (op: ProductionOperation) => (op.completedAt ? Date.parse(op.completedAt) : Date.parse(fs.asOf));
    for (const [ws, list] of byStation) {
      list.sort((a, b) => Date.parse(a.startedAt!) - Date.parse(b.startedAt!));
      for (let i = 1; i < list.length; i++) {
        if (Date.parse(list[i].startedAt!) < end(list[i - 1])) bad(`${ws}: ${list[i].id} overlaps ${list[i - 1].id}`);
      }
      if (list.filter((o) => !o.completedAt && o.status === "RUNNING").length > 1) bad(`${ws}: more than one running operation`);
    }
    for (const ws of Object.values(fs.workstations)) {
      const kind = m.workstations.get(ws.workstationId)!.kind;
      for (const op of ops.filter((x) => x.workstationId === ws.workstationId)) {
        if (op.workstationKind !== kind) bad(`${op.id}: ${op.workstationKind} operation on ${kind} workstation`);
      }
    }
  });

  check("quality, rework and finished goods reconcile", (bad) => {
    for (const o of orders) {
      const insps = o.inspectionIds.map((id) => fs.qualityInspections[id]);
      const passed = insps.reduce((s, i) => s + i.passedQuantity, 0);
      const scrapped = insps.reduce((s, i) => s + i.scrapQuantity, 0);
      if (passed !== o.approvedQuantity || scrapped !== o.scrappedQuantity) bad(`${o.id}: inspection totals disagree with order`);
      if (o.finishedGoodsReceivedQuantity > o.approvedQuantity) bad(`${o.id}: received more FG than QC approved`);
      if (o.status === "COMPLETED") {
        if (o.finishedGoodsReceivedQuantity + o.scrappedQuantity !== o.quantity) bad(`${o.id}: completed but good ${o.finishedGoodsReceivedQuantity} + scrap ${o.scrappedQuantity} != ${o.quantity}`);
        if (o.wipQuantity !== 0) bad(`${o.id}: completed with WIP ${o.wipQuantity}`);
      } else if (o.materialsConsumed) {
        if (o.wipQuantity !== o.quantity - o.scrappedQuantity - o.finishedGoodsReceivedQuantity) bad(`${o.id}: WIP ${o.wipQuantity} does not reconcile`);
      } else if (o.wipQuantity !== 0) bad(`${o.id}: WIP without consumed material`);
    }
    for (const product of master.products) {
      const loc = product.finishedGoodsLocationId;
      const opening = initialState.inventory[inventoryKey(loc, product.id)]?.onHand ?? 0;
      const received = orders.filter((o) => o.productId === product.id).reduce((s, o) => s + o.finishedGoodsReceivedQuantity, 0);
      const shipped = Object.values(fs.shipments).flatMap((s) => s.lines).filter((l) => l.productId === product.id).reduce((s, l) => s + l.quantity, 0);
      const onHand = fs.inventory[inventoryKey(loc, product.id)]?.onHand ?? 0;
      if (opening + received - shipped !== onHand) bad(`${product.id}: opening ${opening} + produced ${received} - shipped ${shipped} != on hand ${onHand}`);
      const reserved = fs.inventory[inventoryKey(loc, product.id)]?.reserved ?? 0;
      const allocated = Object.values(fs.customerOrders).flatMap((c) => c.lines).filter((l) => l.productId === product.id).reduce((s, l) => s + l.allocatedQuantity, 0);
      if (reserved !== allocated) bad(`${product.id}: FG reserved ${reserved} != allocated to order lines ${allocated}`);
    }
  });

  check("shipment quantity constraints", (bad) => {
    const shipped = new Map<Id, number>();
    for (const s of Object.values(fs.shipments)) {
      for (const l of s.lines) shipped.set(l.customerOrderLineId, (shipped.get(l.customerOrderLineId) ?? 0) + l.quantity);
    }
    for (const c of Object.values(fs.customerOrders)) {
      for (const l of c.lines) {
        const total = shipped.get(l.id) ?? 0;
        if (total !== l.shippedQuantity) bad(`${l.id}: shipments sum ${total} != shippedQuantity ${l.shippedQuantity}`);
        if (l.shippedQuantity + l.allocatedQuantity > l.quantity) bad(`${l.id}: shipped + allocated exceeds ordered`);
      }
      const done = c.lines.every((l) => l.shippedQuantity === l.quantity);
      if (c.status === "SHIPPED" && !done) bad(`${c.id}: SHIPPED but lines are open`);
      if (c.status === "PARTIALLY_SHIPPED" && !c.lines.some((l) => l.shippedQuantity > 0)) bad(`${c.id}: PARTIALLY_SHIPPED with nothing shipped`);
    }
  });

  check("replay of initial state + events reproduces final state", (bad) => {
    const { state, error } = replayWithGuard(master, initialState, events);
    if (error) { bad(`replay rejected an event: ${error}`); return; }
    const diff = findFirstDifference(normalize(state), normalize(fs));
    if (diff) bad(`replayed state differs from final state at ${diff}`);
  });

  const problemCount = checks.reduce((s, c) => s + c.problems.length, 0);
  return { ok: problemCount === 0, checks, problemCount };
}
