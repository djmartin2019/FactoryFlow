/**
 * Work-center load: where is WIP waiting and which lane limits flow?
 * Derived from the snapshot only (state + master data), so it works over any
 * source that supplies routing steps with work centers and station capabilities.
 */
import { MIN, inShift, shiftMinutesBetween } from "../manufacturing/calendar.ts";
import { periodWindow, type PeriodId } from "../manufacturing/dashboardMetrics.ts";
import { readyOperations } from "../manufacturing/selectors.ts";
import type { FactoryState, Id, MasterData } from "../manufacturing/types.ts";
import type { ReportingSnapshot } from "./types.ts";

export interface QueuedStep {
  productionOrderId: Id;
  productId: Id;
  units: number;
  standardMinutes: number;
  /** Since when the step has been ready (ISO), when known. */
  readySince?: string;
}

export interface WorkCenterQueue {
  workCenterId: Id;
  name: string;
  stationIds: Id[];
  /** Ready, not-started steps, oldest first. */
  queue: QueuedStep[];
  /** Orders whose next step is this work center and that are not yet started. */
  queuedOrders: number;
  queuedUnits: number;
  /** Σ planned minutes of queued steps (standard work waiting). */
  queuedMinutes: number;
  queuedMinutesPerStation: number | null;
  /** Longest time a queued step has been ready, in shift minutes (off-shift time is not waiting); null when nothing is queued. */
  oldestWaitMinutes: number | null;
  /** Whether the plant is in a shift at the evaluation time. Off shift nothing can start. */
  shiftOpen: boolean;
  /**
   * Largest queuedMinutesPerStation among work centers with a queue; at most one row.
   * Never set off shift: stations cannot start work, so the queue says nothing about capacity.
   */
  isBottleneck: boolean;
}

export interface WorkCenterLoad extends Omit<WorkCenterQueue, "queue"> {
  /** Units on a station of this work center right now (running or paused). */
  inProcessUnits: number;
  /** Run time (excluding machine-failure holds) in the window. */
  busyMinutes: number;
  /** busyMinutes / (serving stations x shift minutes); null when no shift time elapsed. */
  utilization: number | null;
}

/**
 * The queue in front of every work center, and which one is the bottleneck candidate.
 * Shared by the Work Centers table and the 3D queue buffers so the two cannot disagree.
 */
export function workCenterQueues(state: Readonly<FactoryState>, master: MasterData, asOfMs: number): WorkCenterQueue[] {
  const ready = readyOperations(state as FactoryState);
  const shiftOpen = inShift(asOfMs);
  const rows: WorkCenterQueue[] = (master.workCenters ?? []).map((wc) => {
    const stationIds = master.workstations.filter((w) => w.workCenterIds?.includes(wc.id)).map((w) => w.id);
    const queue: QueuedStep[] = ready
      .filter((r) => r.workCenterId === wc.id)
      .map((r) => ({
        productionOrderId: r.productionOrderId,
        productId: state.productionOrders[r.productionOrderId].productId,
        units: r.operation.quantity,
        standardMinutes: r.operation.plannedMinutes,
        readySince: r.readySince,
      }))
      .sort((x, y) => (x.readySince ?? "").localeCompare(y.readySince ?? "") || x.productionOrderId.localeCompare(y.productionOrderId));
    const queuedMinutes = queue.reduce((sum, q) => sum + q.standardMinutes, 0);
    const waits = queue.flatMap((q) => (q.readySince ? [shiftMinutesBetween(Date.parse(q.readySince), asOfMs)] : []));
    return {
      workCenterId: wc.id,
      name: wc.name,
      stationIds,
      queue,
      queuedOrders: queue.length,
      queuedUnits: queue.reduce((sum, q) => sum + q.units, 0),
      queuedMinutes,
      queuedMinutesPerStation: stationIds.length > 0 ? queuedMinutes / stationIds.length : null,
      oldestWaitMinutes: waits.length > 0 ? Math.max(0, Math.round(Math.max(...waits))) : null,
      shiftOpen,
      isBottleneck: false,
    };
  });

  let worst: WorkCenterQueue | undefined;
  for (const r of shiftOpen ? rows : []) {
    if (r.queuedOrders === 0 || r.queuedMinutesPerStation === null) continue;
    if (!worst || r.queuedMinutesPerStation > (worst.queuedMinutesPerStation ?? 0)) worst = r;
  }
  if (worst) worst.isBottleneck = true;
  return rows;
}

export function workCenterLoad(snapshot: ReportingSnapshot, period: PeriodId): WorkCenterLoad[] {
  const { state, master } = snapshot;
  const win = periodWindow(period, snapshot.asOfMs, snapshot.startMs);
  const shiftMinutes = shiftMinutesBetween(win.fromMs, win.toMs);

  return workCenterQueues(state, master, snapshot.asOfMs).map(({ queue: _queue, ...row }) => {
    let inProcessUnits = 0;
    let busyMinutes = 0;
    for (const op of Object.values(state.productionOperations)) {
      if (op.workCenterId !== row.workCenterId || !op.startedAt) continue;
      if (op.status === "RUNNING" || op.status === "PAUSED") inProcessUnits += op.quantity;
      const start = Date.parse(op.startedAt);
      const end = op.completedAt ? Date.parse(op.completedAt) : snapshot.asOfMs;
      const s = Math.max(win.fromMs, start);
      const e = Math.min(win.toMs, end);
      if (e <= s) continue;
      const share = (e - s) / Math.max(1, end - start);
      busyMinutes += Math.max(0, (e - s) / MIN - op.pausedMinutes * share);
    }
    const capacity = row.stationIds.length * shiftMinutes;
    return { ...row, inProcessUnits, busyMinutes, utilization: capacity > 0 ? Math.min(1, busyMinutes / capacity) : null };
  });
}
