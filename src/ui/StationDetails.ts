import type { FactoryObjectConfig } from "../graphics/FactoryObject";
import type { StationMetrics } from "../manufacturing/dashboardMetrics";
import type { ActivityLog } from "../manufacturing/eventFormat";
import { recordsForFactoryObject } from "../manufacturing/mapping";
import type { FactoryState, MasterData } from "../manufacturing/types";
import { STATUS_LABEL, el, formatPct } from "./dom";

/** Live data the panel reads from; supplied by the dashboard each refresh. */
export interface DetailsContext {
  state: Readonly<FactoryState>;
  master: MasterData;
  stations: StationMetrics[];
  log: ActivityLog;
}

export default class StationDetails {
  private readonly element: HTMLDivElement;
  private object: FactoryObjectConfig | null = null;
  private context: (() => DetailsContext | null) | null = null;

  constructor(container: HTMLElement) {
    this.element = document.createElement("div");
    this.element.className = "station-details";

    container.appendChild(this.element);

    this.render(null);
  }

  /** Provide live manufacturing data; without it only layout fields show. */
  public setContext(provider: () => DetailsContext | null): void {
    this.context = provider;
  }

  public render(object: FactoryObjectConfig | null): void {
    this.object = object;
    this.refresh();
  }

  /** Re-render the current selection from the latest simulation state. */
  public refresh(): void {
    const object = this.object;
    this.element.replaceChildren();

    if (!object) {
      this.element.appendChild(el("p", undefined, "Select a factory object to inspect it."));
      return;
    }

    const ctx = this.context?.() ?? null;
    const station = ctx?.stations.find((s) => s.workstationId === object.id);

    this.element.appendChild(el("h2", undefined, object.name ?? object.id));

    const fields: [string, string][] = [["ID", object.id], ["Type", object.type]];

    if (ctx && station) {
      const product = ctx.master.products.find((p) => p.id === station.productId);
      fields.push(
        ["Status", STATUS_LABEL[station.objectStatus]],
        ["Machine", station.runStatus],
        ["Work order", station.currentOrderId ?? "—"],
        ["Product", product?.name ?? "—"],
        ["Queue", `${station.queueLength} order${station.queueLength === 1 ? "" : "s"}`],
        ["Utilization", formatPct(station.utilization)],
      );
    } else {
      fields.push(
        ["Status", object.status ? STATUS_LABEL[object.status] : "Unknown"],
        ["Capacity", object.capacity?.toString() ?? "N/A"],
        ["Fill", object.utilization !== undefined ? formatPct(object.utilization) : "N/A"],
      );
    }
    this.element.appendChild(this.list(fields));

    if (ctx && !station) this.appendInventory(ctx, object.id);
    if (ctx) this.appendEvents(ctx, object.id);
  }

  private list(fields: [string, string][]): HTMLDListElement {
    const dl = el("dl");
    for (const [label, value] of fields) dl.append(el("dt", undefined, label), el("dd", undefined, value));
    return dl;
  }

  private appendInventory(ctx: DetailsContext, objectId: string): void {
    const { inventory } = recordsForFactoryObject(objectId, ctx.state as FactoryState, ctx.master);
    this.element.appendChild(el("h3", undefined, "Stock"));
    if (inventory.length === 0) {
      this.element.appendChild(el("p", undefined, "No stock on hand."));
      return;
    }
    const name = (id: string) =>
      ctx.master.materials.find((m) => m.id === id)?.description ?? ctx.master.products.find((p) => p.id === id)?.name ?? id;
    const table = el("table", "mini");
    const head = el("tr");
    for (const h of ["Item", "On hand", "Reserved"]) head.appendChild(el("th", undefined, h));
    table.appendChild(head);
    for (const b of inventory) {
      const tr = el("tr");
      tr.append(el("td", undefined, name(b.itemId)), el("td", "num", String(b.onHand)), el("td", "num", String(b.reserved)));
      table.appendChild(tr);
    }
    this.element.appendChild(table);
  }

  private appendEvents(ctx: DetailsContext, objectId: string): void {
    const events = ctx.log.latest(5, (e) => e.objectIds.includes(objectId));
    this.element.appendChild(el("h3", undefined, "Recent events"));
    if (events.length === 0) {
      this.element.appendChild(el("p", undefined, "None since playback began."));
      return;
    }
    const ul = el("ul", "mini-events");
    for (const e of events) ul.appendChild(el("li", undefined, `${e.timestamp.slice(5, 10)} ${e.timestamp.slice(11, 16)} · ${e.text}`));
    this.element.appendChild(ul);
  }
}
