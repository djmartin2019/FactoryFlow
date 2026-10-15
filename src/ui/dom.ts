/** Tiny DOM helpers shared by dashboard components (no innerHTML with data). */
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
  idle: "#64748b",
  running: "#22c55e",
  blocked: "#f59e0b",
  down: "#ef4444",
};

export const STATUS_LABEL: Record<string, string> = {
  idle: "Idle",
  running: "Running",
  blocked: "Blocked (material)",
  down: "Down",
};

export const formatSimTime = (d: Date): string =>
  `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;

export const formatPct = (v: number | null): string => (v === null ? "N/A" : `${(v * 100).toFixed(1)}%`);
