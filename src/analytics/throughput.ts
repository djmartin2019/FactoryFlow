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
    points.push({ startMs: s, endMs: s + size, units: 0 });
  }

  let total = 0;
  for (const e of snapshot.events) {
    if (e.type !== "FINISHED_GOODS_RECEIVED") continue;
    const t = Date.parse(e.timestamp);
    if (!inWindow(t, win)) continue;
    if (productId && e.payload.productId !== productId) continue;
    const idx = Math.floor((t - first) / size);
    const point = points[idx];
    if (!point) continue;
    point.units += e.payload.quantity;
    total += e.payload.quantity;
  }

  return { granularity, fromMs: win.fromMs, toMs: win.toMs, productId, points, total };
}
