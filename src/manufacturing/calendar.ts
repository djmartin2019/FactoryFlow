/**
 * Factory calendar (UTC). New work starts Mon-Fri 06:00-18:00; started
 * operations run to completion.
 */
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const SHIFT_START_HOUR = 6;
export const SHIFT_END_HOUR = 18;

export const dayStart = (ms: number) => Math.floor(ms / DAY) * DAY;

export const isWorkingDay = (ms: number) => {
  const d = new Date(ms).getUTCDay();
  return d >= 1 && d <= 5;
};

export const rollToWorkingDay = (ms: number) => {
  while (!isWorkingDay(ms)) ms += DAY;
  return ms;
};

export const inShift = (ms: number) => {
  if (!isWorkingDay(ms)) return false;
  const h = (ms - dayStart(ms)) / HOUR;
  return h >= SHIFT_START_HOUR && h < SHIFT_END_HOUR;
};

/** Scheduled shift minutes inside [fromMs, toMs). */
export function shiftMinutesBetween(fromMs: number, toMs: number): number {
  let total = 0;
  for (let day = dayStart(fromMs); day < toMs; day += DAY) {
    if (!isWorkingDay(day)) continue;
    const s = Math.max(fromMs, day + SHIFT_START_HOUR * HOUR);
    const e = Math.min(toMs, day + SHIFT_END_HOUR * HOUR);
    if (e > s) total += (e - s) / MIN;
  }
  return total;
}
