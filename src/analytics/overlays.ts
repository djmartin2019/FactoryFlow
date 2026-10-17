/**
 * 3D overlay model (slice S6). Decides WHICH factory objects an analytical overlay highlights and how strongly, from the same
 * selectors and analytics the Explorer tabs use. It knows nothing about Three.js: the renderer only turns a cell's intensity into a colour.
 * Semantics: docs/KPI_DEFINITIONS.md ("3D overlays").
 *
 *   queue        stations with orders waiting in front of them      (`workstationViews`, the station table's queue column)
 *   utilization  stations with a utilization figure                 (`stationMetrics`, the station table's utilization column, dashboard period)
 *   shortage     raw-storage locations holding a material that a blocked work order is short of   (`materialShortages`)
 *
 * "status" is the default view and is not an overlay (it returns null): the renderer keeps its normal status colours.
 */
import { periodWindow, stationMetrics } from "../manufacturing/dashboardMetrics.ts";
import { workstationViews } from "../manufacturing/selectors.ts";
import type { FactoryState, Id } from "../manufacturing/types.ts";
import { materialShortages } from "./materialShortages.ts";
import type { PeriodId } from "./periods.ts";
import type { ReportingSnapshot } from "./types.ts";

export const OVERLAY_MODES = ["status", "queue", "utilization", "shortage"] as const;
export type OverlayMode = (typeof OVERLAY_MODES)[number];

export interface OverlayCell {
  objectId: Id;
  /** 0..1 position on the overlay's colour scale. */
  intensity: number;
  /** The measured value behind the intensity. */
  value: number;
  /** Short text for a tooltip or panel. */
  caption: string;
}

export interface Overlay {
  mode: Exclude<OverlayMode, "status">;
  asOfMs: number;
  /** One cell per highlighted object; every other object is drawn muted. */
  cells: OverlayCell[];
  title: string;
  /** What 0 and 1 on the scale mean, and what a muted object means. */
  legend: { low: string; high: string; muted: string };
}

export const OVERLAY_LABELS: Record<OverlayMode, string> = {
  status: "Status",
  queue: "Queue",
  utilization: "Utilization",
  shortage: "Material shortage",
};

const scaled = (value: number, max: number): number => (max > 0 ? Math.min(1, value / max) : 0);

/** The overlay for a mode at the snapshot time; null for "status" (the default colours). */
export function overlayFor(snapshot: ReportingSnapshot, mode: OverlayMode, period: PeriodId): Overlay | null {
  const { state, master, asOfMs } = snapshot;
  if (mode === "status") return null;

  if (mode === "queue") {
    const queued = workstationViews(state as FactoryState, master)
      .map((v) => ({ id: v.workstationId, n: v.queuedOrderIds.length }))
      .filter((v) => v.n > 0);
    const max = Math.max(0, ...queued.map((q) => q.n));
    return {
      mode,
      asOfMs,
      title: "Queue: orders waiting in front of each station",
      cells: queued.map((q) => ({ objectId: q.id, intensity: scaled(q.n, max), value: q.n, caption: `${q.n} order${q.n === 1 ? "" : "s"} waiting` })),
      legend: { low: "1 order waiting", high: `${max} waiting (the most)`, muted: "nothing waiting" },
    };
  }

  if (mode === "utilization") {
    const rows = stationMetrics(state, master, periodWindow(period, asOfMs, snapshot.startMs)).filter((m) => m.utilization !== null);
    return {
      mode,
      asOfMs,
      title: "Utilization: busy ÷ scheduled shift time in the reporting period",
      cells: rows.map((m) => ({ objectId: m.workstationId, intensity: Math.min(1, m.utilization!), value: m.utilization!, caption: `${(m.utilization! * 100).toFixed(0)}% utilized` })),
      legend: { low: "0%", high: "100%", muted: "no utilization figure (no shift time yet)" },
    };
  }

  // shortage: the racks that hold the short materials, weighted by how many blocked work orders are short of something stored there
  const report = materialShortages(snapshot);
  const byLocation = new Map<Id, Set<Id>>();
  for (const o of report.blockedOrders) {
    for (const l of o.lines) {
      const loc = master.materials.find((m) => m.id === l.materialId)?.storageLocationId;
      if (!loc) continue;
      (byLocation.get(loc) ?? byLocation.set(loc, new Set()).get(loc)!).add(o.orderId);
    }
  }
  const max = Math.max(0, ...[...byLocation.values()].map((s) => s.size));
  return {
    mode,
    asOfMs,
    title: "Material shortage: racks holding materials that blocked work orders are short of",
    cells: [...byLocation.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([objectId, orders]) => ({
        objectId,
        intensity: scaled(orders.size, max),
        value: orders.size,
        caption: `${orders.size} blocked work order${orders.size === 1 ? "" : "s"} short of materials stored here`,
      })),
    legend: { low: "1 blocked work order", high: `${max} blocked (the most)`, muted: "no blocked work order is short of a material stored here" },
  };
}

/** The set of highlighted object ids. */
export const highlightedIds = (overlay: Overlay | null): Set<Id> => new Set(overlay?.cells.map((c) => c.objectId));
