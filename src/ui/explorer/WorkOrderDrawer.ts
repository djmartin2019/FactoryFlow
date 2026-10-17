import { TIME_CATEGORIES, type TimeCategory, type WorkOrderDetail, type WorkOrderTime } from "../../analytics";
import { el } from "../dom";
import { kv, section, table } from "./drawerParts";
import { fmtDateTime, fmtDuration, statusBadge, STATUS_TEXT } from "./format";

const OUTCOME: Record<string, string> = {
  PASSED: "Passed",
  REWORK: "Sent to rework",
  SCRAPPED: "Scrapped",
  REWORK_AND_SCRAP: "Rework + scrap",
};

const CATEGORY_LABEL: Record<TimeCategory, string> = {
  PRE_RELEASE: "Before release",
  MATERIAL_BLOCKED: "Blocked: material shortage",
  HELD_MACHINE_DOWN: "Held: machine down",
  PROCESSING: "Processing",
  QUEUE_WAIT: "Waiting to start (in shift)",
  OFF_SHIFT: "Waiting to start (off shift)",
  POST_PRODUCTION: "After last operation, before receipt",
  UNCLASSIFIED: "Unclassified",
};

/** Elapsed-time breakdown (exclusive categories) and contributing conditions (overlapping, indicative). */
function timeSections(t: WorkOrderTime): HTMLElement[] {
  const pct = (ms: number) => (t.elapsedMs > 0 ? `${((100 * ms) / t.elapsedMs).toFixed(0)}%` : "N/A");
  const rows = TIME_CATEGORIES.map((c): [string, string, string] => [CATEGORY_LABEL[c], fmtDuration(t.totalsMs[c]), pct(t.totalsMs[c])]);
  rows.push(["Total elapsed", fmtDuration(t.elapsedMs), "100%"]);
  const c = t.conditions;
  const cond: Array<[string, string]> = [
    ["Material shortage", c.materialShortageMs > 0 ? fmtDuration(c.materialShortageMs) : "none"],
    ["A serving station was down while waiting", c.stationUnavailableMs > 0 ? fmtDuration(c.stationUnavailableMs) : "none"],
    ["Off shift", fmtDuration(c.offShiftMs)],
    ["Changeover setup (inside processing)", `${c.changeoverSetupMinutes} min across ${c.changeovers} changeover${c.changeovers === 1 ? "" : "s"}${c.setupShareOfProcessing === null ? "" : `, ${(c.setupShareOfProcessing * 100).toFixed(0)}% of processing`}`],
  ];
  const now = t.currentWait;
  cond.push([
    "Equipment (current state)",
    now ? (now.missingEquipment.length ? `no free unit now of: ${now.missingEquipment.join(", ")}` : "available now") : "not waiting now",
  ]);
  cond.push([
    "Work-center backlog (current state)",
    now ? `${now.workCenterName}: position ${now.queuePosition} of ${now.queuedOrders} queued, ${Math.round(now.queuedMinutes)} std. min waiting` : "not waiting now",
  ]);
  const flow = kv([
    ["Flow time (created to completed)", t.flowTimeMs === null ? "N/A (not completed)" : fmtDuration(t.flowTimeMs)],
    ["Cycle time (released to completed)", t.cycleTimeMs === null ? "N/A" : fmtDuration(t.cycleTimeMs)],
  ]);
  const hints = [
    "Every moment of the order's life is in exactly one category, so the rows sum to the total" + (t.open ? " (order still open: counted to the current simulated time)" : "") + ". Categories describe what state the order was in, not why.",
  ];
  return [
    section("Elapsed time", flow, table(["Category", "Time", "Share"], rows, [1, 2]), el("p", "hint", hints.join(" "))),
    section(
      "Contributing conditions (indicative, may overlap, not additive)",
      kv(cond),
      el("p", "hint", "These conditions can hold at the same time as each other and as the categories above, so they must not be added up or read as shares of elapsed time. They are context, not proven root causes. Equipment and backlog are observations as of the current simulated time, not durations."),
    ),
  ];
}

/** Right-side detail drawer. Content is rebuilt only when `render` is called. */
export class WorkOrderDrawer {
  readonly element = el("aside", "wo-drawer");
  private readonly title = el("h2");
  private readonly body = el("div", "drawer-body");

  private openCustomerOrder: (id: string) => void = () => {};
  private readonly back = el("button", "btn", "← Back");

  constructor(onClose: () => void) {
    const head = el("div", "drawer-head");
    const close = el("button", "btn", "Close");
    close.setAttribute("aria-label", "Close work order detail");
    close.addEventListener("click", onClose);
    this.back.hidden = true;
    head.append(this.back, this.title, close);
    this.element.append(head, this.body);
    this.element.hidden = true;
  }

  /** Navigation to related entities: customer-order links, and the way back to where the user came from. */
  setNavigation(nav: { onOpenCustomerOrder: (id: string) => void; onBack: () => void }): void {
    this.openCustomerOrder = nav.onOpenCustomerOrder;
    this.back.addEventListener("click", nav.onBack);
  }

  setBackVisible(visible: boolean): void {
    this.back.hidden = !visible;
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

  /** `showInFactory` is set only when a 3D view exists and the work order maps to an object in it. */
  render(d: WorkOrderDetail, time: WorkOrderTime | null = null, showInFactory: (() => void) | null = null): void {
    const scroll = this.body.scrollTop;
    this.element.hidden = false;
    const s = d.summary;
    this.title.textContent = s.id;

    const statusLabel =
      s.status === "BLOCKED"
        ? `Blocked — ${s.blockReason === "MATERIAL_SHORTAGE" ? "material shortage" : "machine down"}`
        : STATUS_TEXT[s.status];
    const customer = el("span");
    if (d.customerOrders.length === 0) customer.append("N/A");
    d.customerOrders.forEach((c, i) => {
      if (i > 0) customer.append(", ");
      const b = el("button", "link-btn", c.id);
      b.title = "Open this customer order (the work order was planned to satisfy it)";
      b.addEventListener("click", () => this.openCustomerOrder(c.id));
      customer.append(b, ` (${c.customerName})`);
    });

    const where = el("p", "hint");
    if (showInFactory) {
      const b = el("button", "btn", "Show in factory");
      b.title = "Select where this work order currently is (or last was) in the 3D plant";
      b.addEventListener("click", showInFactory);
      where.append(b);
    }
    const summary = section(
      "Order summary",
      ...(showInFactory ? [where] : []),
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
        ["Planned for customer order", customer],
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

    this.body.replaceChildren(summary, ...(time ? timeSections(time) : []), routing, materials, quality, timeline);
    this.body.scrollTop = scroll;
  }
}
