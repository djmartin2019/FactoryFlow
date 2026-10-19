import type { ThroughputSeries } from "../../analytics";
import { el, setText } from "../dom";
import { productColor } from "./productColors";

const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag: string, attrs: Record<string, string | number> = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

const W = 1200;
const H = 340;
const M = { top: 12, right: 12, bottom: 48, left: 48 };

const niceMax = (v: number) => {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return v;
};

const pad = (n: number) => String(n).padStart(2, "0");
const hourLabel = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:00`;
};
const dayLabel = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/** Native-SVG bar chart; rebuilt only when handed a different series. */
export class ThroughputChart {
  readonly element = el("div", "chart-wrap");
  private readonly total = el("div", "chart-total");
  private readonly host = el("div", "chart-host");
  private readonly empty = el("div", "empty-state", "No good units were produced in the selected period.");
  private readonly legend = el("div", "chart-legend");
  private lastKey = "";
  private products: Array<{ id: string; name: string }> = [];

  constructor() {
    this.element.append(this.total, this.host, this.legend, this.empty);
  }

  /** Products in master order; a product's colour is its index here. */
  setProducts(products: Array<{ id: string; name: string }>): void {
    this.products = products;
    this.lastKey = "";
  }

  update(series: ThroughputSeries, periodLabel: string, productLabel: string): void {
    setText(this.total, `${series.total.toLocaleString("en-US")} good units — ${periodLabel}, ${productLabel}`);
    this.empty.hidden = series.total > 0;
    const key = `${series.granularity}|${series.fromMs}|${series.toMs}|${series.productId}|${series.points.map((p) => p.units).join(",")}|${this.products.length}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.render(series);
  }

  private render(series: ThroughputSeries): void {
    const { points, granularity } = series;
    const max = niceMax(Math.max(0, ...points.map((p) => p.units)));
    const plotW = W - M.left - M.right;
    const plotH = H - M.top - M.bottom;
    const slot = plotW / points.length;
    const barW = Math.max(2, Math.min(40, slot - 2));

    const shown = this.products.map((p, i) => ({ ...p, color: productColor(i) })).filter((p) => (series.totalsByProduct[p.id] ?? 0) > 0);
    this.legend.replaceChildren(
      ...shown.map((p) => {
        const item = el("span", "legend-item");
        const sw = el("span", "legend-swatch");
        sw.style.background = p.color;
        item.append(sw, `${p.name} · ${(series.totalsByProduct[p.id] ?? 0).toLocaleString("en-US")}`);
        return item;
      }),
    );

    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", role: "img" });
    svg.setAttribute("aria-label", `Good units produced per ${granularity}`);

    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i;
      const y = M.top + plotH - (v / max) * plotH;
      svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: y, y2: y, class: "grid" }));
      const t = svgEl("text", { x: M.left - 6, y: y + 4, "text-anchor": "end", class: "axis-text" });
      t.textContent = String(Math.round(v * 10) / 10);
      svg.append(t);
    }

    const labelEvery = Math.max(1, Math.ceil(points.length / 10));
    points.forEach((p, i) => {
      const x = M.left + i * slot + (slot - barW) / 2;
      const when = granularity === "hour" ? hourLabel(p.startMs) : dayLabel(p.startMs);
      const g = svgEl("g", { class: "bar" });
      const title = svgEl("title");
      const split = shown.filter((q) => (p.byProduct[q.id] ?? 0) > 0).map((q) => `${q.name} ${p.byProduct[q.id]}`);
      title.textContent = `${when} UTC: ${p.units} good unit${p.units === 1 ? "" : "s"}${split.length > 1 ? ` (${split.join(", ")})` : ""}`;
      g.append(title, svgEl("rect", { x: M.left + i * slot, y: M.top, width: slot, height: plotH, class: "hit" }));
      let top = M.top + plotH;
      for (const q of shown) {
        const u = p.byProduct[q.id] ?? 0;
        if (u <= 0) continue;
        const sh = (u / max) * plotH;
        top -= sh;
        const r = svgEl("rect", { x, y: top, width: barW, height: sh, class: "fill", stroke: "var(--panel-solid)", "stroke-width": 0.75 });
        r.style.fill = q.color; // inline style: the stylesheet's .fill rule would override a fill attribute
        g.append(r);
      }
      svg.append(g);
      if (i % labelEvery === 0) {
        const t = svgEl("text", { x: M.left + i * slot + slot / 2, y: H - M.bottom + 16, "text-anchor": "middle", class: "axis-text" });
        t.textContent = granularity === "hour" ? hourLabel(p.startMs).slice(6) : dayLabel(p.startMs);
        svg.append(t);
      }
    });

    svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: M.top + plotH, y2: M.top + plotH, class: "baseline" }));
    const xl = svgEl("text", { x: M.left + plotW / 2, y: H - 6, "text-anchor": "middle", class: "axis-title" });
    xl.textContent = granularity === "hour" ? "Hour starting (UTC)" : "Day (UTC)";
    const yl = svgEl("text", { transform: `translate(12 ${M.top + plotH / 2}) rotate(-90)`, "text-anchor": "middle", class: "axis-title" });
    yl.textContent = `Good units per ${granularity}`;
    svg.append(xl, yl);
    this.host.replaceChildren(svg);
  }
}
