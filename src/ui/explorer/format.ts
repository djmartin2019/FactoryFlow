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
  PLANNED: "#5b7a9d",
  WAITING: "#2ee6ff",
  RUNNING: "#2ee6a6",
  BLOCKED: "#ffb454",
  COMPLETED: "#6f8cff",
  CANCELLED: "#ff5c7a",
  PENDING: "#5b7a9d",
  NOT_STARTED: "#3d5575",
  PAUSED: "#ffb454",
};

export function statusBadge(status: string, label?: string): HTMLElement {
  const b = el("span", "status-badge");
  const dot = el("span", "dot");
  dot.style.background = STATUS_COLOR[status] ?? "#5b7a9d";
  b.append(dot, document.createTextNode(label ?? STATUS_TEXT[status] ?? status));
  return b;
}
