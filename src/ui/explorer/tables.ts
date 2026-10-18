import { el } from "../dom";

/**
 * Explorer table builder with an explicit alignment per column, so a header is always aligned like its cells.
 * `aligns` has one character per header: "n" = numeric (right-aligned), anything else = text (left-aligned).
 * `compact` caps the width so labels and numbers stay near each other on wide screens.
 */
export function exTable(headers: string[], aligns: string, body: HTMLElement, opts: { compact?: boolean } = {}): HTMLElement {
  const tr = el("tr");
  headers.forEach((h, i) => tr.append(el("th", aligns[i] === "n" ? "num" : undefined, h)));
  const thead = el("thead");
  thead.append(tr);
  const table = el("table", "mini-table");
  table.append(thead, body);
  const wrap = el("div", opts.compact ? "tbl-scroll compact" : "tbl-scroll");
  wrap.append(table);
  return wrap;
}

/** Up to `max` ids joined by ", " with a "+N" tail; the full list goes in `title`. */
export function shortList(ids: readonly string[], max = 3): { text: string; title: string } {
  const shown = ids.slice(0, max).join(", ");
  return { text: ids.length > max ? `${shown} +${ids.length - max}` : shown, title: ids.join(", ") };
}
