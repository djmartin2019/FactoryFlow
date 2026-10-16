import { weekdayShort } from "../../manufacturing/calendar";
import { el } from "../dom";

const pad = (n: number) => String(n).padStart(2, "0");

/** Integer cents as "$1,234.56". */
export function fmtMoney(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${pad(abs % 100)}`;
}

/** "Mon 2026-09-14 13:05" in UTC. */
export function fmtDateTime(iso: string | number | undefined): string {
  if (iso === undefined) return "N/A";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "N/A";
  return `${weekdayShort(d.getTime())} ${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "Mon 2026-09-14" */
export function fmtDate(iso: string | number | undefined): string {
  const s = fmtDateTime(iso);
  return s === "N/A" ? s : s.slice(0, 14);
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
