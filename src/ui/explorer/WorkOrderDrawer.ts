import type { WorkOrderDetail } from "../../analytics";
import { el } from "../dom";
import { fmtDateTime, statusBadge, STATUS_TEXT } from "./format";

function table(headers: string[], rows: Array<Array<string | Node>>, numeric: number[] = []): HTMLElement {
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

const section = (title: string, ...children: Node[]) => {
  const s = el("section", "drawer-section");
  s.append(el("h3", undefined, title), ...children);
  return s;
};

const kv = (pairs: Array<[string, string | Node]>) => {
  const dl = el("dl", "kv");
  for (const [k, v] of pairs) {
    dl.append(el("dt", undefined, k));
    const dd = el("dd");
    dd.append(v);
    dl.append(dd);
  }
  return dl;
};

const OUTCOME: Record<string, string> = {
  PASSED: "Passed",
  REWORK: "Sent to rework",
  SCRAPPED: "Scrapped",
  REWORK_AND_SCRAP: "Rework + scrap",
};

/** Right-side detail drawer. Content is rebuilt only when `render` is called. */
export class WorkOrderDrawer {
  readonly element = el("aside", "wo-drawer");
  private readonly title = el("h2");
  private readonly body = el("div", "drawer-body");

  constructor(onClose: () => void) {
    const head = el("div", "drawer-head");
    const close = el("button", "btn", "Close");
    close.setAttribute("aria-label", "Close work order detail");
    close.addEventListener("click", onClose);
    head.append(this.title, close);
    this.element.append(head, this.body);
    this.element.hidden = true;
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  hide(): void {
    this.element.hidden = true;
  }

  renderMissing(id: string): void {
    this.element.hidden = false;
    this.title.textContent = id;
    this.body.replaceChildren(
      el("div", "empty-state", `${id} does not exist at the selected simulation time. Seek forward to see it.`),
    );
  }

  render(d: WorkOrderDetail): void {
    const scroll = this.body.scrollTop;
    this.element.hidden = false;
    const s = d.summary;
    this.title.textContent = s.id;

    const statusLabel =
      s.status === "BLOCKED"
        ? `Blocked — ${s.blockReason === "MATERIAL_SHORTAGE" ? "material shortage" : "machine down"}`
        : STATUS_TEXT[s.status];
    const customer = d.customerOrders.length
      ? d.customerOrders.map((c) => `${c.id} (${c.customerName})`).join(", ")
      : "N/A";

    const summary = section(
      "Order summary",
      kv([
        ["Product", `${s.productName} (${s.sku})`],
        ["Status", statusBadge(s.status, statusLabel)],
        ["Planned quantity", String(s.orderedQuantity)],
        ["Good completed", String(s.goodQuantity)],
        ["Scrapped", String(s.scrapQuantity)],
        ["Awaiting rework", String(d.reworkPendingQuantity)],
        ["Created", fmtDateTime(s.createdAt)],
        ["Released", fmtDateTime(d.releasedAt)],
        ["Started", fmtDateTime(s.startedAt)],
        ["Completed", fmtDateTime(s.completedAt)],
        ["Due", fmtDateTime(s.dueDate)],
        ["Customer order", customer],
      ]),
    );

    const routing = section(
      "Production routing",
      d.routing.length
        ? table(
            ["Seq", "Operation", "Work center", "Workstation", "Status", "Start", "Complete", "Wait / run / hold (min)", "Qty"],
            d.routing.map((r) => [
              String(r.sequence),
              r.isRework ? `${r.label} ↺` : r.label,
              r.workCenter ?? "N/A",
              r.workstationName,
              statusBadge(r.status),
              fmtDateTime(r.startedAt),
              fmtDateTime(r.completedAt),
              r.processingMinutes === undefined ? "N/A" : `${r.waitMinutes ?? "N/A"} / ${r.processingMinutes} / ${r.holdMinutes ?? 0}`,
              r.completedQuantity === null ? "N/A" : String(r.completedQuantity),
            ]),
            [0, 8],
          )
        : el("div", "empty-state", "No routing is configured for this product."),
    );

    const materials = section(
      "Material requirements",
      d.materials.length
        ? table(
            ["Material", "UoM", "Required", "Reserved", "Consumed"],
            d.materials.map((m) => [
              `${m.description} (${m.sku})`,
              m.uom,
              String(m.required),
              m.reserved === null ? "N/A" : String(m.reserved),
              m.consumed === null ? "N/A" : String(m.consumed),
            ]),
            [2, 3, 4],
          )
        : el("div", "empty-state", "No bill of materials for this product."),
      el("p", "hint", "Required = BOM quantity × order quantity. Reserved is the quantity currently held for this order; Consumed is issued to it."),
    );

    const quality = section(
      "Quality history",
      d.inspections.length
        ? table(
            ["Time", "Round", "Station", "Inspected", "Passed", "Failed", "Outcome", "Defects"],
            d.inspections.map((i) => [
              fmtDateTime(i.inspectedAt),
              String(i.round),
              i.workstationName,
              String(i.inspected),
              String(i.passed),
              String(i.failed),
              OUTCOME[i.outcome] + (i.cause ? ` · ${i.cause}` : ""),
              i.defects.length ? i.defects.map((x) => `${x.code.toLowerCase().replace(/_/g, " ")} ×${x.quantity}`).join(", ") : "—",
            ]),
            [1, 3, 4, 5],
          )
        : el("div", "empty-state", "No inspections yet."),
      ...(d.reworkRequests.length
        ? [el("p", "hint", d.reworkRequests.map((r) => `Rework requested ${fmtDateTime(r.timestamp)} (${r.quantity} units)`).join("; "))]
        : []),
    );

    const timeline = section(
      `Event timeline (${d.timeline.length}${d.timelineTotal > d.timeline.length ? ` of ${d.timelineTotal}, most recent` : ""})`,
      d.timeline.length
        ? table(
            ["Time", "Event", "Description", "Where"],
            d.timeline.map((t) => [
              fmtDateTime(t.timestamp),
              t.type.toLowerCase().replace(/_/g, " "),
              t.description,
              t.where ?? "—",
            ]),
          )
        : el("div", "empty-state", "No events yet."),
    );

    this.body.replaceChildren(summary, routing, materials, quality, timeline);
    this.body.scrollTop = scroll;
  }
}
