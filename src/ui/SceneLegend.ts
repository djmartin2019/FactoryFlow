import type { Product } from "../manufacturing/types";
import { el } from "./dom";

const css = (hex: number) => `#${hex.toString(16).padStart(6, "0")}`;

/** Key for the queue buffers drawn in front of the assembly lanes. */
export class SceneLegend {
  readonly element = el("div", "scene-legend");

  constructor(container: HTMLElement, products: readonly Pick<Product, "id" | "name">[], colors: readonly number[]) {
    this.element.append(el("div", "legend-title", "Queued work in front of each lane"));
    products.forEach((p, i) => {
      const row = el("div", "legend-row");
      const swatch = el("span", "legend-swatch");
      swatch.style.background = css(colors[i % colors.length]);
      row.append(swatch, el("span", undefined, `${p.id} ${p.name}`));
      this.element.append(row);
    });
    const hot = el("div", "legend-row");
    const hotSwatch = el("span", "legend-swatch");
    hotSwatch.style.background = "#ffb454";
    hot.append(hotSwatch, el("span", undefined, "Bottleneck candidate (most queued work per station)"));
    this.element.append(hot, el("div", "legend-note", "One box = one queued order; height = units. Faded = off shift (nothing starts until the next shift). Synthetic data."));
    container.appendChild(this.element);
  }
}
