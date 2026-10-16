/**
 * Work-center load: where is WIP waiting and which lane limits flow?
 * Derived from the snapshot only (state + master data), so it works over any
 * source that supplies routing steps with work centers and station capabilities.
 */
import { MIN, shiftMinutesBetween } from "../manufacturing/calendar.ts";
import { periodWindow, type PeriodId } from "../manufacturing/dashboardMetrics.ts";
import { readyOperations } from "../manufacturing/selectors.ts";
import type { FactoryState, Id, WorkCenter } from "../manufacturing/types.ts";
import type { ReportingSnapshot } from "./types.ts";

export interface WorkCenterLoad {
  workCenterId: Id;
  name: string;
  stationIds: Id[];
  /** Units on a station of this work center right now (running or paused). */
  inProcessUnits: number;
  /** Orders whose next step is this work center and that are not yet started. */
  queuedOrders: number;
  queuedUnits: number;
  /** Σ planned minutes of queued steps (standard work waiting). */
  queuedMinutes: number;
  queuedMinutesPerStation: number | null;
  /** Longest time a queued step has been ready, minutes; null when nothing is queued. */
  oldestWaitMinutes: number | null;
  /** Run time (excluding machine-failure holds) in the window. */
  busyMinutes: number;
  /** busyMinutes / (serving stations x shift minutes); null when no shift time elapsed. */
  utilization: number | null;
  /** Largest queuedMinutesPerStation among work centers with a queue; at most one row. */
  isBottleneck: boolean;
}

export function workCenterLoad(snapshot: ReportingSnapshot, period: PeriodId): WorkCenterLoad[] {
  const { state, master } = snapshot;
  const win = periodWindow(period, snapshot.asOfMs, snapshot.startMs);
  const shiftMinutes = shiftMinutesBetween(win.fromMs, win.toMs);
  const centers: WorkCenter[] = master.workCenters ?? [];
  const ready = readyOperations(state as FactoryState);

  const rows: WorkCenterLoad[] = centers.map((wc) => {
    const stationIds = master.workstations.filter((w) => w.workCenterIds?.includes(wc.id)).map((w) => w.id);
    const queue = ready.filter((r) => r.workCenterId === wc.id);
    let inProcessUnits = 0;
    let busyMinutes = 0;
    for (const op of Object.values(state.productionOperations)) {
      if (op.workCenterId !== wc.id || !op.startedAt) continue;
      if (op.status === "RUNNING" || op.status === "PAUSED") inProcessUnits += op.quantity;
      const start = Date.parse(op.startedAt);
      const end = op.completedAt ? Date.parse(op.completedAt) : snapshot.asOfMs;
      const s = Math.max(win.fromMs, start);
      const e = Math.min(win.toMs, end);
      if (e <= s) continue;
      const share = (e - s) / Math.max(1, end - start);
      busyMinutes += Math.max(0, (e - s) / MIN - op.pausedMinutes * share);
    }
    const queuedMinutes = queue.reduce((sum, r) => sum + r.operation.plannedMinutes, 0);
    const waits = queue.flatMap((r) => (r.readySince ? [(snapshot.asOfMs - Date.parse(r.readySince)) / MIN] : []));
    const capacity = stationIds.length * shiftMinutes;
    return {
      workCenterId: wc.id,
      name: wc.name,
      stationIds,
      inProcessUnits,
      queuedOrders: queue.length,
      queuedUnits: queue.reduce((sum, r) => sum + r.operation.quantity, 0),
      queuedMinutes,
      queuedMinutesPerStation: stationIds.length > 0 ? queuedMinutes / stationIds.length : null,
      oldestWaitMinutes: waits.length > 0 ? Math.max(0, Math.round(Math.max(...waits))) : null,
      busyMinutes,
      utilization: capacity > 0 ? Math.min(1, busyMinutes / capacity) : null,
      isBottleneck: false,
    };
  });

  let worst: WorkCenterLoad | undefined;
  for (const r of rows) {
    if (r.queuedOrders === 0 || r.queuedMinutesPerStation === null) continue;
    if (!worst || r.queuedMinutesPerStation > (worst.queuedMinutesPerStation ?? 0)) worst = r;
  }
  if (worst) worst.isBottleneck = true;
  return rows;
}
