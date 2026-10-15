import { el } from "../dom";

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-09-14 13:05" in UTC. */
export function fmtDateTime(iso: string | number | undefined): string {
  if (iso === undefined) return "N/A";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "N/A";
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function fmtDate(iso: string | number | undefined): string {
  return fmtDateTime(iso).slice(0, 10);
}

export const STATUS_TEXT: Record<string, string> = {
  PLANNED: "Planned",
  WAITING: "Released",
  RUNNING: "Running",
  BLOCKED: "Blocked",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  PENDING: "Pending",
  NOT_STARTED: "Not started",
  PAUSED: "Paused",
};

export const STATUS_COLOR: Record<string, string> = {
  PLANNED: "#64748b",
  WAITING: "#38bdf8",
  RUNNING: "#22c55e",
  BLOCKED: "#f59e0b",
  COMPLETED: "#a78bfa",
  CANCELLED: "#ef4444",
  PENDING: "#64748b",
  NOT_STARTED: "#475569",
  PAUSED: "#f59e0b",
};

export function statusBadge(status: string, label?: string): HTMLElement {
  const b = el("span", "status-badge");
  const dot = el("span", "dot");
  dot.style.background = STATUS_COLOR[status] ?? "#64748b";
  b.append(dot, document.createTextNode(label ?? STATUS_TEXT[status] ?? status));
  return b;
}
