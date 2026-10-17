import { el } from "../dom";

/** Small builders shared by the right-hand detail drawers. */
export function table(headers: string[], rows: Array<Array<string | Node>>, numeric: number[] = []): HTMLElement {
  const wrap = el("div", "tbl-scroll");
  const t = el("table", "mini-table");
  const head = el("tr");
  headers.forEach((h, i) => head.append(el("th", numeric.includes(i) ? "num" : undefined, h)));
  const thead = el("thead");
  thead.append(head);
  t.append(thead);
  const body = el("tbody");
  for (const r of rows) {
    const tr = el("tr");
    r.forEach((c, i) => {
      const td = el("td", numeric.includes(i) ? "num" : undefined);
      td.append(c);
      tr.append(td);
    });
    body.append(tr);
  }
  t.append(body);
  wrap.append(t);
  return wrap;
}

export const section = (title: string, ...children: Node[]) => {
  const s = el("section", "drawer-section");
  s.append(el("h3", undefined, title), ...children);
  return s;
};

export const kv = (pairs: Array<[string, string | Node]>) => {
  const dl = el("dl", "kv");
  for (const [k, v] of pairs) {
    dl.append(el("dt", undefined, k));
    const dd = el("dd");
    dd.append(v);
    dl.append(dd);
  }
  return dl;
};

