import type { CustomerOrderDetail } from "../../analytics";
import { el } from "../dom";
import { kv, section, table } from "./drawerParts";
import { fmtDateTime, fmtDuration, STATUS_TEXT, statusBadge } from "./format";

const ORDER_STATUS: Record<string, string> = { OPEN: "Open", PARTIALLY_SHIPPED: "Partly dispatched", SHIPPED: "Dispatched", CANCELLED: "Cancelled" };

/** Right-side detail drawer for one customer order. Dispatch basis: the model records dispatch, not customer receipt. */
export class CustomerOrderDrawer {
  readonly element = el("aside", "wo-drawer");
  private readonly title = el("h2");
  private readonly body = el("div", "drawer-body");
  private readonly back = el("button", "btn", "← Back");
  private openWorkOrder: (id: string) => void = () => {};

  constructor(onClose: () => void) {
    const head = el("div", "drawer-head");
    const close = el("button", "btn", "Close");
    close.setAttribute("aria-label", "Close customer order detail");
    close.addEventListener("click", onClose);
    this.back.hidden = true;
    head.append(this.back, this.title, close);
    this.element.append(head, this.body);
    this.element.hidden = true;
  }

  setNavigation(nav: { onOpenWorkOrder: (id: string) => void; onBack: () => void }): void {
    this.openWorkOrder = nav.onOpenWorkOrder;
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
    this.body.replaceChildren(el("div", "empty-state", `${id} does not exist at the selected simulation time. Seek forward to see it.`));
  }

  /** `showInFactory` is set only when a 3D view exists and the order's finished goods map to an object in it. */
  render(d: CustomerOrderDetail, showInFactory: (() => void) | null = null): void {
    const scroll = this.body.scrollTop;
    this.element.hidden = false;
    this.title.textContent = d.orderId;
    const o = d.dispatch;
    const vsDue =
      o.latenessMs !== null
        ? o.latenessMs === 0
          ? "Dispatched on time"
          : `Dispatched ${fmtDuration(o.latenessMs)} after the due date`
        : o.pastDueMs !== null
          ? `${fmtDuration(o.pastDueMs)} past due, not fully dispatched`
          : o.timeToDueMs !== null
            ? `${fmtDuration(o.timeToDueMs)} until due`
            : "N/A";
    const seg = o.segments
      ? `${fmtDuration(o.segments.toFirstAllocationMs)} to first allocation · ${fmtDuration(o.segments.allocationToFirstDispatchMs)} to first dispatch · ${fmtDuration(o.segments.firstToFinalDispatchMs)} to final dispatch`
      : "N/A";

    const where = el("p", "hint");
    if (showInFactory) {
      const b = el("button", "btn", "Show finished-goods location");
      b.title = "Select where this order's finished goods are stored in the 3D plant";
      b.addEventListener("click", showInFactory);
      where.append(b);
    }
    const summary = section(
      "Order summary",
      ...(showInFactory ? [where] : []),
      kv([
        ["Customer", `${d.customerName} (${d.customerId})`],
        ["Status", ORDER_STATUS[o.status] ?? o.status],
        ["Demand driver", d.demandDriver.toLowerCase().replace(/_/g, " ")],
        ["Created", fmtDateTime(o.createdAtMs)],
        ["Due (dispatch-by)", fmtDateTime(o.dueMs)],
        ["Against the due date", vsDue],
        ["First dispatch", o.firstDispatchMs === null ? "–" : fmtDateTime(o.firstDispatchMs)],
        ["Final dispatch", o.finalDispatchMs === null ? "–" : fmtDateTime(o.finalDispatchMs)],
        ["Order-to-final-dispatch lead time", o.leadTimeMs === null ? "N/A (not fully dispatched)" : fmtDuration(o.leadTimeMs)],
        ["Lead-time segments", seg],
        ["Units ordered / dispatched / unshipped", `${o.orderedQuantity} / ${o.shippedQuantity} / ${o.unshippedQuantity}`],
      ]),
      el("p", "hint", "Dispatch basis: the model records when goods left, not when the customer received them. The due date is treated as dispatch-by for this synthetic manufacturer."),
    );

    const lines = section(
      "Order lines",
      table(
        ["Line", "Product", "Ordered", "Allocated, not yet dispatched", "Dispatched", "Unshipped"],
        d.lines.map((l) => [String(l.lineNumber), `${l.productName} (${l.sku})`, String(l.quantity), String(l.allocatedQuantity), String(l.shippedQuantity), String(l.unshippedQuantity)]),
        [0, 2, 3, 4, 5],
      ),
    );

    const lineNo = new Map(d.lines.map((l) => [l.lineId, l.lineNumber]));
    const allocations = section(
      `Finished-goods allocations (${d.allocations.length})`,
      d.allocations.length
        ? table(["Time", "Line", "Units"], d.allocations.map((a) => [fmtDateTime(a.timestampMs), String(lineNo.get(a.lineId) ?? a.lineId), String(a.quantity)]), [1, 2])
        : el("div", "empty-state", "No finished goods have been allocated to this order yet."),
    );

    const shipments = section(
      `Shipments (${d.shipments.length})`,
      d.shipments.length
        ? table(
            ["Shipment", "Dispatched", "Carrier", "Lines", "Against due date"],
            d.shipments.map((s) => [s.id, fmtDateTime(s.dispatchedAtMs), s.carrier, s.lines.map((l) => `line ${lineNo.get(l.lineId) ?? l.lineId}: ${l.quantity} × ${l.sku}`).join("; "), s.onTime ? "On or before" : "After"]),
          )
        : el("div", "empty-state", "Nothing has been dispatched yet."),
    );

    const planned = section(
      `Work orders planned for this order (${d.plannedWorkOrders.length})`,
      d.plannedWorkOrders.length
        ? table(
            ["Work order", "Product", "Units", "Status", "Created", "Completed", "Order lines"],
            d.plannedWorkOrders.map((w) => {
              const b = el("button", "link-btn", w.id);
              b.addEventListener("click", () => this.openWorkOrder(w.id));
              return [b, w.sku, String(w.quantity), statusBadge(w.status, STATUS_TEXT[w.status] ?? w.status), fmtDateTime(w.createdAtMs), w.completedAtMs === null ? "–" : fmtDateTime(w.completedAtMs), w.lineIds.map((id) => lineNo.get(id) ?? id).join(", ")];
            }),
            [2],
          )
        : el("div", "empty-state", "No work order was planned for this order; it may have been filled from stock."),
      el(
        "p",
        "hint",
        "These work orders were created to satisfy this order's lines. Finished goods are pooled and allocated to order lines from stock, so a shipment cannot be traced to a particular work order: this is a planning link, not a proven flow of units.",
      ),
    );

    this.body.replaceChildren(summary, lines, planned, allocations, shipments);
    this.body.scrollTop = scroll;
  }
}
