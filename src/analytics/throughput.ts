/**
 * Good units produced over time.
 *
 * Definition: a unit is "good" at the FINISHED_GOODS_RECEIVED event, which the
 * manufacturing engine only permits for QC-approved units (rework units are
 * counted once, when they finally pass). Inspections, transfers, allocations
 * and shipments are never counted, so nothing is double-counted. Only events
 * in (window.from, min(window.to, asOf)] contribute.
 */
import { bucketFloor, bucketSizeMs, granularityFor, inWindow, periodWindow, type PeriodId } from "./periods.ts";
import type { Id } from "../manufacturing/types.ts";
import type { ReportingSnapshot, ThroughputPoint, ThroughputSeries } from "./types.ts";

export function goodUnitsThroughput(snapshot: ReportingSnapshot, period: PeriodId, productId: Id | null = null): ThroughputSeries {
  const win = periodWindow(period, snapshot.asOfMs, snapshot.startMs);
  const granularity = granularityFor(win);
  const size = bucketSizeMs(granularity);
  const first = bucketFloor(win.fromMs, granularity);

  const points: ThroughputPoint[] = [];
  // `<=` so an event stamped exactly at `to` on a bucket boundary still has a bucket.
  for (let s = first; s <= win.toMs; s += size) {
    points.push({ startMs: s, endMs: s + size, units: 0, byProduct: {} });
  }

  let total = 0;
  const totalsByProduct: Record<Id, number> = {};
  for (const e of snapshot.events) {
    if (e.type !== "FINISHED_GOODS_RECEIVED") continue;
    const t = Date.parse(e.timestamp);
    if (!inWindow(t, win)) continue;
    if (productId && e.payload.productId !== productId) continue;
    const idx = Math.floor((t - first) / size);
    const point = points[idx];
    if (!point) continue;
    point.units += e.payload.quantity;
    point.byProduct[e.payload.productId] = (point.byProduct[e.payload.productId] ?? 0) + e.payload.quantity;
    totalsByProduct[e.payload.productId] = (totalsByProduct[e.payload.productId] ?? 0) + e.payload.quantity;
    total += e.payload.quantity;
  }

  return { granularity, fromMs: win.fromMs, toMs: win.toMs, productId, points, total, totalsByProduct };
}

export interface ProductOutputRow {
  productId: Id;
  units: number;
  /** Share of all good units in the window (0..1); 0 when nothing was produced. */
  share: number;
  /** Units per elapsed day of the window (calendar time, not shift time). */
  perDay: number;
}

export interface ProductionSummary {
  total: number;
  perDay: number;
  /** Busiest bucket; null when nothing was produced. */
  peak: { startMs: number; units: number } | null;
  /** Buckets with at least one good unit / all buckets. */
  activeBuckets: number;
  buckets: number;
  granularity: ThroughputSeries["granularity"];
  /** One row per master product, most units first (ties in master order). */
  byProduct: ProductOutputRow[];
}

/** Headline numbers and the per-product split behind the Production Analytics tab. Derived from `goodUnitsThroughput`. */
export function productionSummary(snapshot: ReportingSnapshot, period: PeriodId): ProductionSummary {
  const s = goodUnitsThroughput(snapshot, period);
  const days = Math.max((s.toMs - s.fromMs) / (24 * 3_600_000), 1 / 24);
  let peak: ProductionSummary["peak"] = null;
  for (const p of s.points) if (p.units > 0 && (!peak || p.units > peak.units)) peak = { startMs: p.startMs, units: p.units };
  const byProduct = snapshot.master.products
    .map((p) => {
      const units = s.totalsByProduct[p.id] ?? 0;
      return { productId: p.id, units, share: s.total > 0 ? units / s.total : 0, perDay: units / days };
    })
    .sort((a, b) => b.units - a.units);
  return {
    total: s.total,
    perDay: s.total / days,
    peak,
    activeBuckets: s.points.filter((p) => p.units > 0).length,
    buckets: s.points.length,
    granularity: s.granularity,
    byProduct,
  };
}
