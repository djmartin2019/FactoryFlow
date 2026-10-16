/**
 * Work order (production order) read model: summaries, counts and detail.
 * Everything derives from the snapshot (state + applied events) at one
 * timestamp, so it can never show future orders or events.
 */
import { shiftMinutesBetween } from "../manufacturing/calendar.ts";
import { WORK_CENTER_NAMES } from "../manufacturing/masterData.ts";
import type {
  FactoryEvent,
  FactoryState,
  Id,
  MasterData,
  OperationType,
  ProductionOperation,
  ProductionOrder,
} from "../manufacturing/types.ts";
import type {
  InspectionView,
  MaterialRequirementView,
  ReportingSnapshot,
  RoutingStepView,
  TimelineEntry,
  WorkOrderCategory,
  WorkOrderCounts,
  WorkOrderDetail,
  WorkOrderSummary,
} from "./types.ts";

const OPERATION_LABELS: Record<OperationType, string> = {
  MOUNT_AND_WIRE: "Mount & wire",
  MOTOR_CIRCUIT_ASSEMBLY: "Motor circuit assembly",
  PLC_HMI_INTEGRATION: "PLC / HMI integration",
  KIT: "Kit materials",
  MOUNT: "Mount components",
  WIRE: "Wire & terminate",
  CONFIGURE: "PLC / HMI configuration",
  FINAL_TEST: "Final test",
  REWORK: "Rework",
};

export const operationLabel = (type: string): string =>
  OPERATION_LABELS[type as OperationType] ?? type.toLowerCase().replace(/_/g, " ");

export function categoryOf(order: Pick<ProductionOrder, "status" | "startedAt">): WorkOrderCategory {
  switch (order.status) {
    case "COMPLETED":
      return "COMPLETED";
    case "CANCELLED":
      return "CANCELLED";
    case "RUNNING":
      return "IN_PROGRESS";
    case "BLOCKED":
      return order.startedAt ? "IN_PROGRESS" : "OPEN";
    default:
      return "OPEN";
  }
}

const wsName = (master: MasterData, id?: Id): string | undefined =>
  id ? master.workstations.find((w) => w.id === id)?.name ?? master.locations.find((l) => l.id === id)?.name ?? id : undefined;

/** customer order line id -> customer order id */
function lineIndex(state: Readonly<FactoryState>): Map<Id, Id> {
  const map = new Map<Id, Id>();
  for (const co of Object.values(state.customerOrders)) for (const l of co.lines) map.set(l.id, co.id);
  return map;
}

function operationsOf(state: Readonly<FactoryState>, order: ProductionOrder): ProductionOperation[] {
  return order.operationIds
    .map((id) => state.productionOperations[id])
    .filter((o): o is ProductionOperation => !!o)
    .sort((a, b) => a.sequence - b.sequence);
}

function summarize(
  order: ProductionOrder,
  state: Readonly<FactoryState>,
  master: MasterData,
  lines: Map<Id, Id>,
): WorkOrderSummary {
  const product = master.products.find((p) => p.id === order.productId);
  const ops = operationsOf(state, order);
  const active = ops.find((o) => o.status === "RUNNING" || o.status === "PAUSED");
  const done = ops.filter((o) => o.status === "COMPLETED").length;
  const customerOrderIds = [...new Set(order.demandLineIds.map((l) => lines.get(l)).filter((x): x is Id => !!x))];
  const category = categoryOf(order);
  return {
    id: order.id,
    productId: order.productId,
    sku: product?.sku ?? order.productId,
    productName: product?.name ?? order.productId,
    customerOrderIds,
    orderedQuantity: order.quantity,
    goodQuantity: order.finishedGoodsReceivedQuantity,
    scrapQuantity: order.scrappedQuantity,
    status: order.status,
    category,
    blockReason: order.blockReason,
    currentOperation: active
      ? {
          label: active.isRework ? `Rework (${operationLabel(active.type)})` : operationLabel(active.type),
          workstationId: active.workstationId,
          workstationName: wsName(master, active.workstationId),
        }
      : null,
    createdAt: order.createdAt,
    createdAtMs: Date.parse(order.createdAt),
    dueDate: order.dueDate,
    dueMs: Date.parse(order.dueDate),
    startedAt: order.startedAt,
    completedAt: order.completedAt,
    progress: order.status === "COMPLETED" ? 1 : ops.length ? done / ops.length : 0,
  };
}

/** One summary per production order that exists in the state at this timestamp. */
export function workOrderSummaries(snapshot: ReportingSnapshot): WorkOrderSummary[] {
  const { state, master, asOfMs } = snapshot;
  const lines = lineIndex(state);
  return Object.values(state.productionOrders)
    .filter((o) => Date.parse(o.createdAt) <= asOfMs)
    .map((o) => summarize(o, state, master, lines));
}

export function workOrderCounts(summaries: readonly WorkOrderSummary[]): WorkOrderCounts {
  const c: WorkOrderCounts = { total: summaries.length, open: 0, inProgress: 0, completed: 0, cancelled: 0 };
  for (const s of summaries) {
    if (s.category === "OPEN") c.open++;
    else if (s.category === "IN_PROGRESS") c.inProgress++;
    else if (s.category === "COMPLETED") c.completed++;
    else c.cancelled++;
  }
  return c;
}

/** Events that reference this production order through the canonical entity refs, up to `asOfMs`. */
export function workOrderEvents(snapshot: ReportingSnapshot, orderId: Id): FactoryEvent[] {
  const out: FactoryEvent[] = [];
  for (const e of snapshot.events) {
    if (e.entities.productionOrderId !== orderId) continue;
    if (Date.parse(e.timestamp) > snapshot.asOfMs) continue;
    out.push(e);
  }
  // Chronological; sequence is the tie-breaker for identical timestamps.
  out.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.sequence - b.sequence);
  return out;
}

function describe(e: FactoryEvent, state: Readonly<FactoryState>, master: MasterData): { text: string; where?: string } {
  const opLabel = (id?: Id) => {
    const op = id ? state.productionOperations[id] : undefined;
    return op ? (op.isRework ? "Rework" : operationLabel(op.type)) : "operation";
  };
  const where = wsName(master, e.entities.workstationId);
  const material = (id: Id) => master.materials.find((m) => m.id === id)?.description ?? id;
  switch (e.type) {
    case "PRODUCTION_ORDER_CREATED":
      return { text: `Created for ${e.payload.productionOrder.quantity} units` };
    case "PRODUCTION_ORDER_RELEASED":
      return { text: `Released; ${e.payload.reservations.length} materials reserved` };
    case "PRODUCTION_ORDER_CANCELLED":
      return { text: "Cancelled (demand cancelled)" };
    case "PRODUCTION_BLOCKED":
      return {
        text:
          e.payload.reason === "MACHINE_DOWN"
            ? "Blocked: machine down"
            : `Blocked: short of ${(e.payload.shortages ?? []).map((s) => material(s.materialId)).join(", ") || "material"}`,
        where,
      };
    case "PRODUCTION_RESUMED":
      return { text: "Resumed after repair", where };
    case "MATERIAL_CONSUMED":
      return { text: `Materials issued (${e.payload.consumptions.length} items)` };
    case "PRODUCTION_STARTED":
      return { text: "Production started", where };
    case "OPERATION_STARTED":
      return { text: `${opLabel(e.payload.productionOperationId)} started`, where };
    case "OPERATION_COMPLETED":
      return { text: `${opLabel(e.payload.productionOperationId)} completed`, where };
    case "PRODUCTION_COMPLETED":
      return { text: `Assembly complete (${e.payload.quantityProduced} units)`, where };
    case "QUALITY_INSPECTION_COMPLETED": {
      const i = e.payload.inspection;
      return { text: `Inspection round ${i.round}: ${i.passedQuantity}/${i.inspectedQuantity} passed`, where };
    }
    case "REWORK_REQUESTED":
      return { text: `Rework requested for ${e.payload.quantity} units` };
    case "FINISHED_GOODS_RECEIVED": {
      const loc = wsName(master, e.payload.locationId);
      return { text: `${e.payload.quantity} good units received into finished goods`, where: loc };
    }
    default:
      return { text: e.type.toLowerCase().replace(/_/g, " "), where };
  }
}

export function workOrderTimeline(snapshot: ReportingSnapshot, orderId: Id): TimelineEntry[] {
  return workOrderEvents(snapshot, orderId).map((e) => {
    const d = describe(e, snapshot.state, snapshot.master);
    return {
      eventId: e.id,
      sequence: e.sequence,
      timestamp: e.timestamp,
      type: e.type,
      description: d.text,
      where: d.where,
    };
  });
}

export function workOrderDetail(snapshot: ReportingSnapshot, orderId: Id, timelineLimit = 100): WorkOrderDetail | null {
  const { state, master } = snapshot;
  const order = state.productionOrders[orderId];
  if (!order || Date.parse(order.createdAt) > snapshot.asOfMs) return null;

  const summary = summarize(order, state, master, lineIndex(state));
  const events = workOrderEvents(snapshot, orderId);

  // Routing: configured steps from master data, matched to this order's operation records.
  const routing = master.routings.find((r) => r.productId === order.productId);
  const ops = operationsOf(state, order);
  const used = new Set<Id>();
  const steps: RoutingStepView[] = [];
  const view = (op: ProductionOperation, label: string, isRework: boolean): RoutingStepView => ({
    sequence: op.sequence,
    operationType: op.type,
    label,
    isRework,
    operationId: op.id,
    workstationId: op.workstationId,
    workstationName: wsName(master, op.workstationId) ?? `Any ${op.workstationKind.toLowerCase()} station`,
    ...(op.workCenterId ? { workCenter: WORK_CENTER_NAMES[op.workCenterId] ?? op.workCenterId } : {}),
    status: op.status === "PENDING" ? "PENDING" : op.status,
    startedAt: op.startedAt,
    completedAt: op.completedAt,
    completedQuantity: op.status === "COMPLETED" ? op.quantity : null,
    plannedQuantity: op.quantity,
  });
  for (const step of routing?.steps ?? []) {
    const op = ops.find((o) => !o.isRework && o.sequence === step.sequence && !used.has(o.id));
    if (op) {
      used.add(op.id);
      steps.push(view(op, operationLabel(step.operationType), false));
    } else {
      steps.push({
        sequence: step.sequence,
        operationType: step.operationType,
        label: operationLabel(step.operationType),
        isRework: false,
        workstationName: `Any ${step.workstationKind.toLowerCase()} station`,
        status: "NOT_STARTED",
        completedQuantity: null,
      });
    }
  }
  // Anything not matched to a routing step (rework passes, re-tests) follows in sequence.
  for (const op of ops) {
    if (used.has(op.id)) continue;
    steps.push(view(op, op.isRework ? "Rework" : `${operationLabel(op.type)} (re-test)`, true));
  }

  // Wait / processing / hold per attempt (see KPI_DEFINITIONS "Work-order operation times").
  let readyAt = order.releasedAt ? Date.parse(order.releasedAt) : undefined;
  for (const step of steps) {
    if (!step.startedAt) continue;
    const start = Date.parse(step.startedAt);
    // Waiting is shift time: nothing can start overnight or at weekends, so that is not queue delay.
    if (readyAt !== undefined) step.waitMinutes = Math.round(shiftMinutesBetween(readyAt, start));
    const op = step.operationId ? state.productionOperations[step.operationId] : undefined;
    if (step.completedAt && op) {
      const elapsed = Math.round((Date.parse(step.completedAt) - start) / 60000);
      step.holdMinutes = op.pausedMinutes;
      step.processingMinutes = Math.max(0, elapsed - op.pausedMinutes);
      readyAt = Date.parse(step.completedAt);
    }
  }

  // Materials: required from BOM x order quantity; reserved/consumed only where attributable.
  const bom = master.billsOfMaterials.find((b) => b.productId === order.productId);
  const consumedEvent = events.find((e) => e.type === "MATERIAL_CONSUMED");
  const materials: MaterialRequirementView[] = (bom?.lines ?? []).map((line) => {
    const m = master.materials.find((x) => x.id === line.materialId);
    const consumption =
      consumedEvent?.type === "MATERIAL_CONSUMED"
        ? consumedEvent.payload.consumptions.find((c) => c.materialId === line.materialId)
        : undefined;
    const reservation = order.reservations.find((r) => r.materialId === line.materialId);
    return {
      materialId: line.materialId,
      sku: m?.sku ?? line.materialId,
      description: m?.description ?? line.materialId,
      uom: m?.uom ?? "EA",
      required: line.quantityPer * order.quantity,
      // Order-level quantities are attributable through the order's own reservations and issue event.
      // Reserved = still held (zero before release, after issue, or after cancellation).
      reserved: order.materialsConsumed ? 0 : (reservation?.quantity ?? 0),
      consumed: consumption?.quantity ?? 0,
    };
  });

  const inspections: InspectionView[] = order.inspectionIds
    .map((id) => state.qualityInspections[id])
    .filter((i) => !!i && Date.parse(i.inspectedAt) <= snapshot.asOfMs)
    .map((i) => ({
      id: i.id,
      inspectedAt: i.inspectedAt,
      round: i.round,
      workstationId: i.workstationId,
      workstationName: wsName(master, i.workstationId) ?? i.workstationId,
      inspected: i.inspectedQuantity,
      passed: i.passedQuantity,
      failed: i.failedQuantity,
      rework: i.reworkQuantity,
      scrap: i.scrapQuantity,
      outcome:
        i.failedQuantity === 0
          ? ("PASSED" as const)
          : i.reworkQuantity > 0 && i.scrapQuantity > 0
            ? ("REWORK_AND_SCRAP" as const)
            : i.reworkQuantity > 0
              ? ("REWORK" as const)
              : ("SCRAPPED" as const),
      defects: i.defects.map((d) => ({ code: d.code, quantity: d.quantity })),
      cause: i.cause ? (i.cause.kind === "MACHINE_FAILURE" ? "Machine failure" : "Process variation") : undefined,
    }));

  const reworkRequests = events.flatMap((e) =>
    e.type === "REWORK_REQUESTED"
      ? [{ timestamp: e.timestamp, quantity: e.payload.quantity, inspectionId: e.payload.inspectionId }]
      : [],
  );

  const timeline = workOrderTimeline(snapshot, orderId);
  const customerOrders = summary.customerOrderIds.map((id) => {
    const co = state.customerOrders[id];
    return {
      id,
      customerName: master.customers.find((c) => c.id === co?.customerId)?.name ?? co?.customerId ?? "N/A",
      status: co?.status ?? "N/A",
    };
  });

  return {
    summary,
    customerOrders,
    approvedQuantity: order.approvedQuantity,
    reworkPendingQuantity: order.reworkPendingQuantity,
    releasedAt: order.releasedAt,
    routing: steps,
    materials,
    inspections,
    reworkRequests,
    timeline: timeline.slice(-timelineLimit),
    timelineTotal: timeline.length,
  };
}
