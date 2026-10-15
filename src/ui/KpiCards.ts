import {
  KPI_DEFINITIONS,
  PERIODS,
  type KpiId,
  type KpiValue,
  type PeriodId,
} from "../manufacturing/dashboardMetrics";
import { el, setText } from "./dom";

const ORDER: KpiId[] = ["goodUnits", "wip", "activeOrders", "utilization", "firstPassYield", "shortageBlocked"];

export class KpiCards {
  readonly element = el("section", "kpis");
  private readonly values = new Map<KpiId, HTMLElement>();
  private readonly select = el("select", "kpi-period");

  constructor(onPeriodChange: (period: PeriodId) => void) {
    this.select.setAttribute("aria-label", "KPI measurement period");
    for (const p of PERIODS) {
      const option = el("option", undefined, p.label);
      option.value = p.id;
      this.select.appendChild(option);
    }
    this.select.addEventListener("change", () => onPeriodChange(this.select.value as PeriodId));

    for (const id of ORDER) {
      const def = KPI_DEFINITIONS[id];
      const card = el("article", "kpi");
      card.title = [
        def.definition,
        def.numerator && `Numerator: ${def.numerator}`,
        def.denominator && `Denominator: ${def.denominator}`,
        `Window: ${def.window}`,
        `Source: ${def.source}`,
        `Limitations: ${def.limitations}`,
      ]
        .filter(Boolean)
        .join("\n");

      const label = el("div", "kpi-label", def.label);
      const value = el("div", "kpi-value", "–");
      const scope = el("div", "kpi-scope", def.scope === "current" ? "Current" : "Selected period");
      card.append(label, value, scope);
      this.values.set(id, value);
      this.element.appendChild(card);
    }
  }

  get periodSelect(): HTMLSelectElement {
    return this.select;
  }

  update(kpis: Record<KpiId, KpiValue>): void {
    for (const id of ORDER) {
      const node = this.values.get(id)!;
      const k = kpis[id];
      setText(node, k.display);
      node.classList.toggle("na", k.value === null);
    }
  }
}
