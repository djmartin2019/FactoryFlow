/**
 * Dashboard KPIs and station metrics, derived purely from FactoryState.
 * No DOM, no Three.js, no timers. `nowMs` is the single authoritative
 * simulated timestamp supplied by the caller (SimulationController clock).
 *
 * Exact definitions are documented in docs/KPI_DEFINITIONS.md and mirrored
 * in KPI_DEFINITIONS below (shown as tooltips in the UI).
 */
import { HOUR, DAY, MIN, shiftMinutesBetween } from "./calendar.ts";
import { workstationViews } from "./selectors.ts";
import type { FactoryState, Id, MasterData } from "./types.ts";

export type PeriodId = "24h" | "7d" | "all";

export const PERIODS: ReadonlyArray<{ id: PeriodId; label: string; ms: number }> = [
  { id: "24h", label: "Last 24 h", ms: DAY },
  { id: "7d", label: "Last 7 d", ms: 7 * DAY },
  { id: "all", label: "Since start", ms: Infinity },
];

export type KpiId =
  | "goodUnits"
  | "wip"
  | "activeOrders"
  | "utilization"
  | "firstPassYield"
  | "shortageBlocked";

export interface KpiDefinition {
  id: KpiId;
  label: string;
  scope: "historical" | "current";
  definition: string;
  numerator?: string;
  denominator?: string;
  window: string;
  source: string;
  limitations: string;
}

export const KPI_DEFINITIONS: Record<KpiId, KpiDefinition> = {
  goodUnits: {
    id: "goodUnits",
    label: "Good units produced",
    scope: "historical",
    definition: "QC-approved units received into finished goods during the period.",
    numerator: "Σ finishedGoodsReceivedQuantity of production orders with completedAt in (windowStart, now]",
    window: "Selected period, clipped to simulation start",
    source: "state.productionOrders[].finishedGoodsReceivedQuantity / completedAt (set by FINISHED_GOODS_RECEIVED)",
    limitations: "Each order is received in one event, so units are attributed to the receipt time, not to when they were built.",
  },
  wip: {
    id: "wip",
    label: "Work in progress",
    scope: "current",
    definition: "Units whose materials were consumed but that are not yet in finished goods or scrapped.",
    numerator: "Σ wipQuantity over all production orders",
    window: "Instantaneous (current simulated time)",
    source: "state.productionOrders[].wipQuantity",
    limitations: "Counts units, not orders. Units still queued before material consumption are not WIP.",
  },
  activeOrders: {
    id: "activeOrders",
    label: "Active production orders",
    scope: "current",
    definition: "Production orders released to the floor or blocked: status WAITING, RUNNING or BLOCKED.",
    numerator: "count of orders with status ∈ {WAITING, RUNNING, BLOCKED}",
    window: "Instantaneous (current simulated time)",
    source: "state.productionOrders[].status",
    limitations: "PLANNED (not yet released), COMPLETED and CANCELLED orders are excluded.",
  },
  utilization: {
    id: "utilization",
    label: "Workstation utilization",
    scope: "historical",
    definition: "Busy time of all workstations divided by their scheduled shift time during the period.",
    numerator: "Σ per station min(shiftMinutes, operation run minutes in window, excluding machine downtime)",
    denominator: "stations × scheduled shift minutes in window (Mon–Fri 06:00–18:00 UTC)",
    window: "Selected period, clipped to simulation start",
    source: "state.productionOperations[].startedAt/completedAt, state.downtimes[], factory calendar",
    limitations:
      "Run time outside scheduled shifts (operations finish after 18:00) is capped per station at 100%. N/A until a shift minute has elapsed.",
  },
  firstPassYield: {
    id: "firstPassYield",
    label: "First-pass quality yield",
    scope: "historical",
    definition: "Share of units that passed their first (round 1) quality inspection.",
    numerator: "Σ passedQuantity of round-1 inspections with inspectedAt in window",
    denominator: "Σ inspectedQuantity of the same inspections",
    window: "Selected period, clipped to simulation start",
    source: "state.qualityInspections[] (round, inspectedAt, passedQuantity, inspectedQuantity)",
    limitations: "N/A when no round-1 inspection completed in the window. Re-inspections after rework are excluded by definition.",
  },
  shortageBlocked: {
    id: "shortageBlocked",
    label: "Blocked by material shortage",
    scope: "current",
    definition: "Production orders currently blocked because required material is unavailable.",
    numerator: "count of orders with status BLOCKED and blockReason MATERIAL_SHORTAGE",
    window: "Instantaneous (current simulated time)",
    source: "state.productionOrders[].status / blockReason",
    limitations: "Machine-down blocks are excluded.",
  },
};

export interface KpiValue {
  id: KpiId;
  /** null => N/A (required data unavailable). */
  value: number | null;
  /** Pre-formatted for display. */
  display: string;
  numerator?: number;
  denominator?: number;
}

export interface PeriodWindow {
  period: PeriodId;
  fromMs: number;
  toMs: number;
}

export function periodWindow(period: PeriodId, nowMs: number, startMs: number): PeriodWindow {
  const len = PERIODS.find((p) => p.id === period)!.ms;
  return { period, fromMs: Math.max(startMs, nowMs - len), toMs: nowMs };
}

export interface StationMetrics {
  workstationId: Id;
  name: string;
  runStatus: "IDLE" | "RUNNING" | "DOWN";
  objectStatus: "idle" | "running" | "blocked" | "down";
  currentOrderId?: Id;
  productId?: Id;
  queueLength: number;
  /** Busy / scheduled shift minutes in window (0..1); null when no shift time elapsed. */
  utilization: number | null;
  busyMinutes: number;
  shiftMinutes: number;
}

function busyMinutes(state: Readonly<FactoryState>, workstationId: Id, win: PeriodWindow): number {
  const downs = Object.values(state.downtimes).filter((d) => d.workstationId === workstationId);
  let busy = 0;
  for (const op of Object.values(state.productionOperations)) {
    if (op.workstationId !== workstationId || !op.startedAt) continue;
    const s = Math.max(win.fromMs, Date.parse(op.startedAt));
    const e = Math.min(win.toMs, op.completedAt ? Date.parse(op.completedAt) : win.toMs);
    if (e <= s) continue;
    let minutes = (e - s) / MIN;
    // Operations are paused while their machine is down: exclude that time.
    for (const d of downs) {
      const ds = Math.max(s, Date.parse(d.failedAt));
      const de = Math.min(e, d.restoredAt ? Date.parse(d.restoredAt) : win.toMs);
      if (de > ds) minutes -= (de - ds) / MIN;
    }
    busy += Math.max(0, minutes);
  }
  return busy;
}

export function stationMetrics(state: Readonly<FactoryState>, master: MasterData, win: PeriodWindow): StationMetrics[] {
  const shiftMinutes = shiftMinutesBetween(win.fromMs, win.toMs);
  const views = workstationViews(state as FactoryState, master);
  return master.workstations.map((ws) => {
    const view = views.find((v) => v.workstationId === ws.id)!;
    const order = view.currentOrderId ? state.productionOrders[view.currentOrderId] : undefined;
    const busy = Math.min(shiftMinutes, busyMinutes(state, ws.id, win));
    return {
      workstationId: ws.id,
      name: ws.name,
      runStatus: view.runStatus,
      objectStatus: view.objectStatus,
      currentOrderId: view.currentOrderId,
      productId: order?.productId,
      queueLength: view.queuedOrderIds.length,
      utilization: shiftMinutes > 0 ? busy / shiftMinutes : null,
      busyMinutes: busy,
      shiftMinutes,
    };
  });
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export function computeKpis(
  state: Readonly<FactoryState>,
  master: MasterData,
  win: PeriodWindow,
  stations: StationMetrics[] = stationMetrics(state, master, win),
): Record<KpiId, KpiValue> {
  let goodUnits = 0;
  let wip = 0;
  let active = 0;
  let shortage = 0;
  for (const o of Object.values(state.productionOrders)) {
    wip += o.wipQuantity;
    if (o.status === "WAITING" || o.status === "RUNNING" || o.status === "BLOCKED") active++;
    if (o.status === "BLOCKED" && o.blockReason === "MATERIAL_SHORTAGE") shortage++;
    if (o.completedAt) {
      const t = Date.parse(o.completedAt);
      if (t > win.fromMs && t <= win.toMs) goodUnits += o.finishedGoodsReceivedQuantity;
    }
  }

  let inspected = 0;
  let passed = 0;
  for (const i of Object.values(state.qualityInspections)) {
    if (i.round !== 1) continue;
    const t = Date.parse(i.inspectedAt);
    if (t >= win.fromMs && t <= win.toMs) {
      inspected += i.inspectedQuantity;
      passed += i.passedQuantity;
    }
  }

  const shiftTotal = stations.length * (stations[0]?.shiftMinutes ?? 0);
  const busyTotal = stations.reduce((s, x) => s + x.busyMinutes, 0);

  return {
    goodUnits: { id: "goodUnits", value: goodUnits, display: String(goodUnits), numerator: goodUnits },
    wip: { id: "wip", value: wip, display: String(wip), numerator: wip },
    activeOrders: { id: "activeOrders", value: active, display: String(active), numerator: active },
    utilization:
      shiftTotal > 0
        ? { id: "utilization", value: busyTotal / shiftTotal, display: pct(busyTotal / shiftTotal), numerator: busyTotal, denominator: shiftTotal }
        : { id: "utilization", value: null, display: "N/A" },
    firstPassYield:
      inspected > 0
        ? { id: "firstPassYield", value: passed / inspected, display: pct(passed / inspected), numerator: passed, denominator: inspected }
        : { id: "firstPassYield", value: null, display: "N/A" },
    shortageBlocked: { id: "shortageBlocked", value: shortage, display: String(shortage), numerator: shortage },
  };
}

export const formatDuration = (ms: number): string => {
  const h = ms / HOUR;
  return h >= 48 ? `${(h / 24).toFixed(1)} d` : `${h.toFixed(1)} h`;
};
