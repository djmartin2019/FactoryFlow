/** Reporting-period maths. Reuses the dashboard's period definitions so both views agree. */
import { DAY, HOUR } from "../manufacturing/calendar.ts";
import { PERIODS, periodWindow, type PeriodId, type PeriodWindow } from "../manufacturing/dashboardMetrics.ts";
import type { Granularity } from "./types.ts";

export { PERIODS, periodWindow };
export type { PeriodId, PeriodWindow };

/** Windows up to two days are bucketed hourly, longer ones daily. */
export function granularityFor(win: { fromMs: number; toMs: number }): Granularity {
  return win.toMs - win.fromMs <= 2 * DAY ? "hour" : "day";
}

export const bucketSizeMs = (g: Granularity): number => (g === "hour" ? HOUR : DAY);

/** Start of the UTC hour/day containing `ms`. */
export const bucketFloor = (ms: number, g: Granularity): number => Math.floor(ms / bucketSizeMs(g)) * bucketSizeMs(g);

/** Reporting windows are half-open: (fromMs, toMs]. Matches the dashboard KPIs. */
export const inWindow = (ms: number, win: { fromMs: number; toMs: number }): boolean => ms > win.fromMs && ms <= win.toMs;
