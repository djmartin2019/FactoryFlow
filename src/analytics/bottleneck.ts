/**
 * Bottleneck explanation (slice S3). Semantics: docs/KPI_DEFINITIONS.md ("Bottleneck explanation"), which is
 * authoritative.
 *
 * The bottleneck *candidate* is the existing Work Centers definition (largest queued standard minutes per serving
 * station). This module only lists CONTRIBUTING CONDITIONS around a work center. They are independent observations
 * that can hold together; they are never added up, ranked against each other, weighted or called root causes.
 * "Current" fields are observations as of the snapshot time; "period" fields are measured over the reporting period.
 */
import { shiftMinutesBetween } from "../manufacturing/calendar.ts";
import type { Id } from "../manufacturing/types.ts";
import { periodWindow, type PeriodId, type PeriodWindow } from "./periods.ts";
import type { ReportingSnapshot } from "./types.ts";
import { workCenterLoad, workCenterQueues } from "./workCenters.ts";

export interface BottleneckExplanation {
  workCenterId: Id;
  name: string;
  /** True when this is the work center the Work Centers table flags as the bottleneck candidate. */
  flagged: boolean;
  asOfMs: number;
  /** Whether the plant is in a shift now. Off shift nothing can start and no candidate is flagged. */
  shiftOpen: boolean;
  /** Observations as of `asOfMs`. */
  current: {
    queuedOrders: number;
    queuedUnits: number;
    queuedMinutes: number;
    stations: number;
    queuedMinutesPerStation: number | null;
    /** 1 = largest queued minutes per station among work centers that have a queue. */
    rank: number | null;
    /** Work centers that currently have a queue. */
    rankedOf: number;
    /** The next-largest queued minutes per station among the others, for comparison; null if there is none. */
    nextHighestPerStation: number | null;
    /** Shift minutes the longest-waiting queued step has been ready. */
    oldestWaitMinutes: number | null;
    stationsDownNow: Array<{ id: Id; name: string }>;
    stationsRunningNow: number;
    /** Queued steps that cannot start because every unit of a required equipment kind is held. */
    waitingOnEquipment: number;
    /** Distinct equipment kinds with no free unit that queued steps need. */
    missingEquipmentKinds: string[];
  };
  /** Measured over the reporting period. */
  period: {
    window: PeriodWindow;
    /** Run time excluding failure holds ÷ (serving stations × shift minutes); null when no shift time elapsed. */
    utilization: number | null;
    busyMinutes: number;
    /** Setup minutes applied by steps that started in the period (part of busy time), and how many followed a different product. */
    setupMinutes: number;
    changeovers: number;
    /** setupMinutes ÷ busyMinutes; null when there was no busy time. */
    setupShareOfBusy: number | null;
    /** Shift minutes during which serving stations were down, summed over stations (stations serving several work centers are counted in each). */
    stationDowntimeMinutes: number;
    /** stationDowntimeMinutes ÷ (serving stations × shift minutes); null when no shift time elapsed. */
    stationDowntimeShare: number | null;
  };
  /** Plant-wide context, not specific to this work center: orders held before release by a material shortage. */
  plant: { materialBlockedOrders: number };
}

/** One explanation per work center (callers normally use the flagged one). Empty for sources without work centers. */
export function bottleneckExplanations(snapshot: ReportingSnapshot, period: PeriodId): BottleneckExplanation[] {
  const { state, master, asOfMs } = snapshot;
  const window = periodWindow(period, asOfMs, snapshot.startMs);
  const queues = workCenterQueues(state, master, asOfMs);
  const loads = new Map(workCenterLoad(snapshot, period).map((l) => [l.workCenterId, l]));
  const shiftMinutes = shiftMinutesBetween(window.fromMs, window.toMs);
  const withQueue = queues.filter((q) => q.queuedOrders > 0 && q.queuedMinutesPerStation !== null);
  const materialBlockedOrders = Object.values(state.productionOrders).filter((o) => o.status === "BLOCKED" && o.blockReason === "MATERIAL_SHORTAGE").length;

  return queues.map((q) => {
    const load = loads.get(q.workCenterId)!;
    const stations = q.stationIds.map((id) => ({ id, name: master.workstations.find((w) => w.id === id)?.name ?? id }));
    const down = stations.filter((s) => state.workstations[s.id]?.status === "DOWN");
    const running = stations.filter((s) => state.workstations[s.id]?.status === "RUNNING").length;

    let stationDowntimeMinutes = 0;
    for (const d of Object.values(state.downtimes)) {
      if (!q.stationIds.includes(d.workstationId)) continue;
      const from = Math.max(window.fromMs, Date.parse(d.failedAt));
      const to = Math.min(window.toMs, d.restoredAt ? Date.parse(d.restoredAt) : asOfMs);
      if (to > from) stationDowntimeMinutes += shiftMinutesBetween(from, to);
    }

    const ranked = withQueue.slice().sort((a, b) => b.queuedMinutesPerStation! - a.queuedMinutesPerStation! || a.workCenterId.localeCompare(b.workCenterId));
    const idx = ranked.findIndex((r) => r.workCenterId === q.workCenterId);
    const others = ranked.filter((r) => r.workCenterId !== q.workCenterId);
    const capacity = q.stationIds.length * shiftMinutes;

    return {
      workCenterId: q.workCenterId,
      name: q.name,
      flagged: q.isBottleneck,
      asOfMs,
      shiftOpen: q.shiftOpen,
      current: {
        queuedOrders: q.queuedOrders,
        queuedUnits: q.queuedUnits,
        queuedMinutes: q.queuedMinutes,
        stations: q.stationIds.length,
        queuedMinutesPerStation: q.queuedMinutesPerStation,
        rank: idx < 0 ? null : idx + 1,
        rankedOf: ranked.length,
        nextHighestPerStation: others.length ? others[0].queuedMinutesPerStation : null,
        oldestWaitMinutes: q.oldestWaitMinutes,
        stationsDownNow: down,
        stationsRunningNow: running,
        waitingOnEquipment: q.waitingOnEquipment,
        missingEquipmentKinds: [...new Set(q.queue.flatMap((s) => s.missingEquipment))].sort(),
      },
      period: {
        window,
        utilization: load.utilization,
        busyMinutes: load.busyMinutes,
        setupMinutes: load.setupMinutes,
        changeovers: load.changeovers,
        setupShareOfBusy: load.busyMinutes > 0 ? load.setupMinutes / load.busyMinutes : null,
        stationDowntimeMinutes,
        stationDowntimeShare: capacity > 0 ? stationDowntimeMinutes / capacity : null,
      },
      plant: { materialBlockedOrders },
    };
  });
}

/** The explanation for the flagged bottleneck candidate, or null when none is flagged (off shift, or no queue). */
export function flaggedBottleneck(snapshot: ReportingSnapshot, period: PeriodId): BottleneckExplanation | null {
  return bottleneckExplanations(snapshot, period).find((e) => e.flagged) ?? null;
}
