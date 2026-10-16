/** Tiny DOM helpers shared by dashboard components (no innerHTML with data). */
import { weekdayShort } from "../manufacturing/calendar";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Only touch the DOM when the value actually changed. */
export function setText(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export const STATUS_HEX: Record<string, string> = {
  idle: "#5b7a9d",
  running: "#2ee6a6",
  blocked: "#ffb454",
  down: "#ff5c7a",
};

export const STATUS_LABEL: Record<string, string> = {
  idle: "Idle",
  running: "Running",
  blocked: "Blocked (material)",
  down: "Down",
};

/** "Mon 2026-09-07 14:00 UTC" */
export const formatSimTime = (d: Date): string =>
  `${weekdayShort(d.getTime())} ${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;

/** "Mon 09-07 14:00" for compact lists (activity feed, station events). ISO input. */
export const formatShortTime = (iso: string): string =>
  `${weekdayShort(Date.parse(iso))} ${iso.slice(5, 10)} ${iso.slice(11, 16)}`;

export const formatPct = (v: number | null): string => (v === null ? "N/A" : `${(v * 100).toFixed(1)}%`);
