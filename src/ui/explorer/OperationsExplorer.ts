/**
 * Operations Explorer: full-page, read-only reporting view.
 *
 * It owns no simulation state or clock. Each refresh it asks the shared
 * SimulationController for a snapshot and re-derives reporting data only when
 * events were applied (or history was reset/sought), throttled to REFRESH_MS.
 */
import {
  PERIODS,
  billsOfMaterials,
  compareByAttention,
  dispatchReport,
  qualityReport,
  materialShortages,
  customerOrderDetail,
  type MaterialShortageReport,
  bottleneckExplanations,
  type BottleneckExplanation,
  type QualityGroup,
  type QualityReport,
  type DispatchReport,
  type OrderDispatchView,
  goodUnitsThroughput,
  equipmentLoad,
  workCenterLoad,
  workOrderCounts,
  workOrderDetail,
  workOrderSummaries,
  workOrderTime,
  type PeriodId,
  type WorkOrderCategory,
  type WorkOrderSummary,
} from "../../analytics";
import { reportingSnapshot } from "../../simulation/reportingSnapshot";
import type { SimulationController } from "../../simulation/SimulationController";
import { inShift as inShiftNow, nextShiftStart, weekdayShort } from "../../manufacturing/calendar";
import { el, formatSimTime, setText } from "../dom";
import { fmtDate, fmtDateTime, fmtDuration, fmtMoney, fmtRate, statusBadge, STATUS_TEXT } from "./format";
import { ThroughputChart } from "./ThroughputChart";
import { CustomerOrderDrawer } from "./CustomerOrderDrawer";
import { WorkOrderDrawer } from "./WorkOrderDrawer";
import { entityTab, type EntityRef, type ExplorerTab } from "../route";

const REFRESH_MS = 500;
const PAGE_SIZE = 100;

type Tab = ExplorerTab;
type SortKey = "id" | "product" | "ordered" | "good" | "status" | "created" | "due" | "progress";

interface Column {
  key: SortKey | null;
  label: string;
  numeric?: boolean;
}

const COLUMNS: Column[] = [
  { key: "id", label: "Work order" },
  { key: "product", label: "Product / SKU" },
  { key: null, label: "Customer order" },
  { key: "ordered", label: "Ordered", numeric: true },
  { key: "good", label: "Good", numeric: true },
  { key: "status", label: "Status" },
  { key: null, label: "Current operation" },
  { key: "created", label: "Created", numeric: true },
  { key: "due", label: "Due", numeric: true },
  { key: "progress", label: "Progress" },
];

const SORTERS: Record<SortKey, (a: WorkOrderSummary, b: WorkOrderSummary) => number> = {
  id: (a, b) => a.id.localeCompare(b.id),
  product: (a, b) => a.productName.localeCompare(b.productName) || a.id.localeCompare(b.id),
  ordered: (a, b) => a.orderedQuantity - b.orderedQuantity,
  good: (a, b) => a.goodQuantity - b.goodQuantity,
  status: (a, b) => a.status.localeCompare(b.status),
  created: (a, b) => a.createdAtMs - b.createdAtMs,
  due: (a, b) => a.dueMs - b.dueMs,
  progress: (a, b) => a.progress - b.progress,
};

type StatusFilter = "ALL" | WorkOrderCategory | "BLOCKED";

interface RowEntry {
  tr: HTMLTableRowElement;
  cells: HTMLTableCellElement[];
  sig: string;
}

export class OperationsExplorer {
  readonly element = el("div", "view view-explorer");

  private readonly sim: SimulationController;
  private readonly getPeriod: () => PeriodId;

  private active = false;
  private tab: Tab = "orders";
  private lastRun = 0;
  private dataKey = "";
  private chartKey = "";
  private summaries: WorkOrderSummary[] = [];

  // controls / state
  private search = "";
  private statusFilter: StatusFilter = "ALL";
  private sortKey: SortKey = "created";
  private sortDir: 1 | -1 = -1;
  private visibleLimit = PAGE_SIZE;
  private selectedId: string | null = null;
  private productFilter = "ALL";

  // DOM
  private readonly clock = el("span", "meta-value");
  private readonly periodLabel = el("span", "meta-value");
  private readonly tabButtons = new Map<Tab, HTMLButtonElement>();
  private readonly panels = new Map<Tab, HTMLElement>();
  private readonly kpiValues: Record<"total" | "open" | "inProgress" | "completed", HTMLElement> = {
    total: el("div", "kpi-value", "–"),
    open: el("div", "kpi-value", "–"),
    inProgress: el("div", "kpi-value", "–"),
    completed: el("div", "kpi-value", "–"),
  };
  private readonly kpiNote = el("div", "hint");
  private readonly resultCount = el("span", "hint");
  private readonly tbody = el("tbody");
  private readonly empty = el("div", "empty-state");
  private readonly more = el("button", "btn", "Show more");
  private readonly headerCells = new Map<SortKey, HTMLTableCellElement>();
  private readonly rows = new Map<string, RowEntry>();
  private renderedOrder: string[] = [];
  private readonly drawer: WorkOrderDrawer;
  private readonly coDrawer: CustomerOrderDrawer;
  private selectedCoId: string | null = null;
  private coDrawerKey = "";
  /** Entities the user navigated away from through drawer links; the drawers' Back button walks it. */
  private trail: EntityRef[] = [];
  private routeListener: (() => void) | null = null;
  private readonly chart = new ThroughputChart();
  private readonly productSelect = el("select", "ctl");
  private drawerKey = "";

  private readonly cleanup: Array<() => void> = [];

  constructor(sim: SimulationController, getPeriod: () => PeriodId) {
    this.sim = sim;
    this.getPeriod = getPeriod;
    this.drawer = new WorkOrderDrawer(() => this.closeDetail());
    this.coDrawer = new CustomerOrderDrawer(() => this.closeCustomerOrder());
    this.drawer.setNavigation({ onOpenCustomerOrder: (id) => this.openEntity({ kind: "customer-order", id }, true), onBack: () => this.goBack() });
    this.coDrawer.setNavigation({ onOpenWorkOrder: (id) => this.openEntity({ kind: "work-order", id }, true), onBack: () => this.goBack() });

    this.element.append(this.buildHeader(), this.buildTabs(), this.buildOrdersPanel(), this.buildDispatchPanel(), this.buildQualityPanel(), this.buildShortagesPanel(), this.buildAnalyticsPanel(), this.buildWorkCentersPanel(), this.buildBomPanel(), this.buildInventoryPanel(), this.drawer.element, this.coDrawer.element);
    this.element.hidden = true;
    this.showTab("orders");

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !this.active) return;
      if (this.coDrawer.isOpen) this.closeCustomerOrder();
      else if (this.drawer.isOpen) this.closeDetail();
    };
    window.addEventListener("keydown", onKey);
    this.cleanup.push(() => window.removeEventListener("keydown", onKey));
  }

  // ---- lifecycle ---------------------------------------------------------

  setActive(active: boolean): void {
    this.active = active;
    this.element.hidden = !active;
    if (active) this.update(true);
  }

  /** Called from the shared dashboard refresh timer. Throttled. */
  update(force = false): void {
    if (!this.active) return;
    const now = performance.now();
    setText(this.clock, formatSimTime(this.sim.currentTime));
    setText(this.periodLabel, PERIODS.find((p) => p.id === this.getPeriod())!.label);
    if (!force && now - this.lastRun < REFRESH_MS) return;
    this.lastRun = now;

    const snap = reportingSnapshot(this.sim);
    const key = `${this.sim.epoch}:${snap.state.lastSequence}`;
    const changed = key !== this.dataKey;
    if (changed) {
      this.dataKey = key;
      this.summaries = workOrderSummaries(snap);
      const c = workOrderCounts(this.summaries);
      setText(this.kpiValues.total, String(c.total));
      setText(this.kpiValues.open, String(c.open));
      setText(this.kpiValues.inProgress, String(c.inProgress));
      setText(this.kpiValues.completed, String(c.completed));
      setText(this.kpiNote, c.cancelled > 0 ? `Created total includes ${c.cancelled} cancelled order${c.cancelled === 1 ? "" : "s"}.` : "");
    }

    if (this.tab === "orders") {
      if (changed || this.tableDirty) this.renderTable();
      this.renderDrawer(changed);
    } else if (this.tab === "bom") {
      // Master data: render once per master, not per event.
      const master = snap.master;
      if (this.bomMaster !== master) {
        this.bomMaster = master;
        this.renderBom(master);
      }
    } else if (this.tab === "workcenters") {
      const wk = `${key}|${this.getPeriod()}|${Math.floor(snap.asOfMs / 60_000)}`;
      if (wk !== this.wcKey) {
        this.wcKey = wk;
        this.renderWorkCenters(workCenterLoad(snap, this.getPeriod()), snap.asOfMs);
        this.renderEquipment(equipmentLoad(snap, this.getPeriod()));
        this.renderWhy(bottleneckExplanations(snap, this.getPeriod()).find((e) => e.flagged) ?? null, snap.asOfMs);
      }
    } else if (this.tab === "dispatch") {
      const dk = `${key}|${this.getPeriod()}|${Math.floor(snap.asOfMs / 60_000)}`;
      if (dk !== this.dispatchKey) {
        this.dispatchKey = dk;
        this.renderDispatch(dispatchReport(snap, this.getPeriod()));
      }
      this.renderCoDrawer(changed);
    } else if (this.tab === "quality") {
      const qk = `${key}|${this.getPeriod()}|${Math.floor(snap.asOfMs / 60_000)}`;
      if (qk !== this.qualityKey) {
        this.qualityKey = qk;
        this.renderQuality(qualityReport(snap, this.getPeriod()));
      }
    } else if (this.tab === "shortages") {
      const sk = `${key}|${Math.floor(snap.asOfMs / 60_000)}`;
      if (sk !== this.shortagesKey) {
        this.shortagesKey = sk;
        this.renderShortages(materialShortages(snap));
      }
    } else if (this.tab === "analytics") {
      const ck = `${key}|${this.getPeriod()}|${this.productFilter}|${Math.floor(snap.asOfMs / 60_000)}`;
      if (ck !== this.chartKey) {
        this.chartKey = ck;
        const series = goodUnitsThroughput(snap, this.getPeriod(), this.productFilter === "ALL" ? null : this.productFilter);
        const product = snap.master.products.find((p) => p.id === this.productFilter);
        this.chart.update(
          series,
          PERIODS.find((p) => p.id === this.getPeriod())!.label.toLowerCase(),
          product ? product.name : "all products",
        );
      }
    }
  }

  dispose(): void {
    for (const c of this.cleanup) c();
    this.cleanup.length = 0;
    this.element.remove();
  }

  // ---- layout ------------------------------------------------------------

  private buildHeader(): HTMLElement {
    const h = el("header", "ex-header");
    const titles = el("div");
    titles.append(
      el("h2", "ex-title", "Operations Explorer"),
      el("p", "ex-subtitle", "Production orders, operational performance, and manufacturing history"),
    );
    const meta = el("div", "ex-meta");
    const item = (label: string, value: HTMLElement) => {
      const w = el("div", "meta-item");
      w.append(el("span", "meta-label", label), value);
      return w;
    };
    meta.append(
      item("Simulated time", this.clock),
      item("Reporting period", this.periodLabel),
      el("span", "demo-badge", "Demo Mode — Synthetic Manufacturing Data"),
    );
    h.append(titles, meta);
    return h;
  }

  private buildTabs(): HTMLElement {
    const bar = el("div", "tabs");
    bar.setAttribute("role", "tablist");
    const defs: Array<[Tab, string]> = [
      ["orders", "Work Orders"],
      ["dispatch", "Dispatch"],
      ["quality", "Quality"],
      ["shortages", "Material Shortages"],
      ["analytics", "Production Analytics"],
      ["workcenters", "Work Centers"],
      ["bom", "Bill of Materials"],
      ["inventory", "Inventory"],
    ];
    for (const [id, label] of defs) {
      const b = el("button", "tab", label);
      b.setAttribute("role", "tab");
      b.addEventListener("click", () => {
        this.showTab(id);
        this.update(true);
      });
      this.tabButtons.set(id, b);
      bar.append(b);
    }
    return bar;
  }

  private showTab(tab: Tab): void {
    this.tab = tab;
    for (const [id, b] of this.tabButtons) {
      b.classList.toggle("active", id === tab);
      b.setAttribute("aria-selected", String(id === tab));
    }
    for (const [id, p] of this.panels) p.hidden = id !== tab;
    if (tab !== "orders") this.drawer.hide();
    else this.drawerKey = "";
    if (tab !== "dispatch") this.coDrawer.hide();
    else this.coDrawerKey = "";
    this.notifyRoute();
  }

  private buildOrdersPanel(): HTMLElement {
    const panel = el("section", "ex-panel");
    this.panels.set("orders", panel);

    const cards = el("div", "ex-kpis");
    const card = (label: string, key: keyof typeof this.kpiValues, tip: string) => {
      const c = el("article", "kpi");
      c.title = tip;
      c.append(el("div", "kpi-label", label), this.kpiValues[key], el("div", "kpi-scope", "As of simulated time"));
      cards.append(c);
    };
    card("Production orders created", "total", "All production orders created up to the current simulated time (future orders excluded), including cancelled.");
    card("Open", "open", "PLANNED, released (WAITING), or BLOCKED before production started.");
    card("In progress", "inProgress", "RUNNING, or BLOCKED after production started (e.g. machine down).");
    card("Completed", "completed", "Status COMPLETED: QC-approved units received into finished goods.");

    const controls = el("div", "ex-controls");
    const search = el("input", "ctl search");
    search.type = "search";
    search.placeholder = "Search work order, product, SKU or customer order…";
    search.setAttribute("aria-label", "Search work orders");
    search.addEventListener("input", () => {
      this.search = search.value.trim().toLowerCase();
      this.visibleLimit = PAGE_SIZE;
      this.dirtyTable();
    });
    const status = el("select", "ctl");
    status.setAttribute("aria-label", "Filter by status");
    const opts: Array<[StatusFilter, string]> = [
      ["ALL", "All statuses"],
      ["OPEN", "Open"],
      ["IN_PROGRESS", "In progress"],
      ["BLOCKED", "Blocked (any)"],
      ["COMPLETED", "Completed"],
      ["CANCELLED", "Cancelled"],
    ];
    for (const [v, l] of opts) {
      const o = el("option", undefined, l);
      o.value = v;
      status.append(o);
    }
    status.addEventListener("change", () => {
      this.statusFilter = status.value as StatusFilter;
      this.visibleLimit = PAGE_SIZE;
      this.dirtyTable();
    });
    controls.append(search, status, this.resultCount);

    const wrap = el("div", "tbl-scroll orders-table");
    const table = el("table", "orders");
    const head = el("tr");
    for (const col of COLUMNS) {
      const th = el("th", col.numeric ? "num" : undefined, col.label);
      if (col.key) {
        th.classList.add("sortable");
        th.tabIndex = 0;
        const k = col.key;
        const go = () => {
          if (this.sortKey === k) this.sortDir = this.sortDir === 1 ? -1 : 1;
          else {
            this.sortKey = k;
            this.sortDir = k === "id" || k === "product" || k === "status" ? 1 : -1;
          }
          this.dirtyTable();
        };
        th.addEventListener("click", go);
        th.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            go();
          }
        });
        this.headerCells.set(k, th);
      }
      head.append(th);
    }
    const thead = el("thead");
    thead.append(head);
    table.append(thead, this.tbody);
    wrap.append(table);

    // One delegated listener for row clicks (no per-row listeners to leak).
    this.tbody.addEventListener("click", (e) => {
      const tr = (e.target as HTMLElement).closest("tr");
      const id = tr?.dataset.id;
      if (id) this.openDetail(id);
    });

    this.empty.hidden = true;
    this.more.addEventListener("click", () => {
      this.visibleLimit += PAGE_SIZE;
      this.dirtyTable();
    });
    panel.append(cards, this.kpiNote, controls, wrap, this.empty, this.more);
    return panel;
  }

  private buildAnalyticsPanel(): HTMLElement {
    const panel = el("section", "ex-panel");
    this.panels.set("analytics", panel);
    panel.append(el("h3", "panel-title", "Good units produced over time"));

    const controls = el("div", "ex-controls");
    this.productSelect.setAttribute("aria-label", "Filter by product");
    const all = el("option", undefined, "All products");
    all.value = "ALL";
    this.productSelect.append(all);
    for (const p of this.sim.engine.master.products) {
      const o = el("option", undefined, `${p.name} (${p.sku})`);
      o.value = p.id;
      this.productSelect.append(o);
    }
    this.productSelect.addEventListener("change", () => {
      this.productFilter = this.productSelect.value;
      this.update(true);
    });
    controls.append(this.productSelect);

    panel.append(
      controls,
      this.chart.element,
      el(
        "p",
        "hint",
        "Good unit = QC-approved unit received into finished goods (finished-goods receipt event). Rework units count once, when they pass. Window (start, now]; the reporting period is chosen in the header.",
      ),
    );
    return panel;
  }

  private readonly bomRoot = el("div", "bom-root");
  private bomMaster: unknown = null;

  private buildBomPanel(): HTMLElement {
    const panel = el("section", "ex-panel");
    this.panels.set("bom", panel);
    panel.append(
      this.bomRoot,
      el(
        "p",
        "hint",
        "Quantities are per finished unit. Unit cost is the material's standard cost; the total equals the product's standard cost. Lead time is the supplier's standard lead time in calendar days. Synthetic demo master data.",
      ),
    );
    return panel;
  }

  private renderBom(master: Parameters<typeof billsOfMaterials>[0]): void {
    const sections = billsOfMaterials(master).map((b) => {
      const section = el("section", "bom-product");
      const head = el("div", "bom-head");
      head.append(
        el("h3", undefined, `${b.sku} — ${b.name}`),
        el(
          "span",
          "hint",
          `BOM ${b.bomId} rev ${b.version} · ${b.lines.length} components · standard cost ${fmtMoney(b.totalCostCents)} · list price ${fmtMoney(b.listPriceCents)} · longest lead time ${b.longestLeadTimeDays} d`,
        ),
      );
      const wrap = el("div", "tbl-scroll");
      const table = el("table", "mini-table");
      const headRow = el("tr");
      ["SKU", "Description", "UoM", "Qty per", "Unit cost", "Extended", "Supplier", "Lead time"].forEach((h, i) =>
        headRow.append(el("th", i === 3 || i === 4 || i === 5 || i === 7 ? "num" : undefined, h)),
      );
      const thead = el("thead");
      thead.append(headRow);
      const tbody = el("tbody");
      for (const l of b.lines) {
        const tr = el("tr");
        [l.sku, l.description, l.uom, String(l.quantityPer), fmtMoney(l.unitCostCents), fmtMoney(l.extendedCostCents), l.supplierName, `${l.leadTimeDays} d`].forEach(
          (c, i) => tr.append(el("td", i === 3 || i === 4 || i === 5 || i === 7 ? "num" : undefined, c)),
        );
        tbody.append(tr);
      }
      const total = el("tr");
      total.append(el("td", undefined, "Total"), ...Array.from({ length: 4 }, () => el("td")), el("td", "num", fmtMoney(b.totalCostCents)), el("td"), el("td"));
      tbody.append(total);
      table.append(thead, tbody);
      wrap.append(table);
      section.append(head, wrap);
      return section;
    });
    this.bomRoot.replaceChildren(...sections);
  }

  // ---- dispatch (S1a) ----------------------------------------------------
  // Semantics: docs/KPI_DEFINITIONS.md "dispatch, lead time and work-order time". Dispatch basis, observed facts only.

  private dispatchKey = "";
  private readonly dispatchCards = el("div", "ex-kpis");
  private readonly dispatchNote = el("p", "hint");
  private readonly pastDueBody = el("tbody");
  private readonly pastDueWrap = el("div");
  private readonly ordersBody = el("tbody");
  private readonly ordersCount = el("span", "hint");

  private buildDispatchPanel(): HTMLElement {
    const panel = el("section", "ex-panel");
    this.panels.set("dispatch", panel);
    const head = (labels: string[], numFrom: number) => {
      const tr = el("tr");
      labels.forEach((h, i) => tr.append(el("th", i >= numFrom ? "num" : undefined, h)));
      const thead = el("thead");
      thead.append(tr);
      return thead;
    };
    const cols = ["Customer order", "Customer", "Status", "Due", "Past due", "Unshipped qty", "Planned work orders"];
    const pastTable = el("table", "mini-table");
    pastTable.append(head(cols, 4), this.pastDueBody);
    const pastScroll = el("div", "tbl-scroll");
    pastScroll.append(pastTable);
    this.pastDueWrap.append(el("h3", undefined, "Past-Due Unshipped Orders"), pastScroll);

    const allCols = ["Customer order", "Customer", "Status", "Created", "Due", "Final dispatch", "Lead time", "Lateness / status vs due", "Lead-time segments", "Planned work orders"];
    const allTable = el("table", "mini-table");
    allTable.append(head(allCols, 6), this.ordersBody);
    const allScroll = el("div", "tbl-scroll");
    allScroll.append(allTable);

    panel.append(
      this.dispatchCards,
      this.dispatchNote,
      this.pastDueWrap,
      el("h3", undefined, "Customer orders"),
      this.ordersCount,
      allScroll,
      el(
        "p",
        "hint",
        "Dispatch basis: the model records when goods left, not when a customer received them, and the due date is treated as dispatch-by for this synthetic manufacturer. On-Time In-Full Dispatch counts orders whose due date falls in the reporting period and has passed; an order dispatched in part by its due date is not in full, and orders still unshipped past due count as late. Planned work orders are the work orders created to satisfy the order's lines; finished goods are allocated from stock, so this is a planning link, not a proven unit flow. No delivery forecast is shown. Synthetic data.",
      ),
    );
    return panel;
  }

  private workOrderLinks(o: OrderDispatchView): HTMLElement {
    const td = el("td");
    const shown = o.plannedWorkOrderIds.slice(0, 3);
    shown.forEach((id, i) => {
      if (i > 0) td.append(" ");
      const b = el("button", "link-btn", id);
      b.title = "Open this work order (planned to satisfy the customer order)";
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.openWorkOrder(id);
      });
      td.append(b);
    });
    if (o.plannedWorkOrderIds.length > shown.length) td.append(` +${o.plannedWorkOrderIds.length - shown.length}`);
    if (shown.length === 0) td.append("–");
    return td;
  }

  private renderDispatch(r: DispatchReport): void {
    const card = (label: string, value: string, scope: string, tip: string) => {
      const c = el("article", "kpi");
      c.title = tip;
      c.append(el("div", "kpi-label", label), el("div", "kpi-value", value), el("div", "kpi-scope", scope));
      return c;
    };
    const ratio = (x: { numerator: number; denominator: number }, unit: string) => `${x.numerator} / ${x.denominator} ${unit}`;
    const lt = r.leadTime;
    this.dispatchCards.replaceChildren(
      card("On-Time In-Full Dispatch", fmtRate(r.onTimeInFull.rate), ratio(r.onTimeInFull, "orders due in period"), "Orders due in the period (and already due) that were fully dispatched on or before the due date. Unshipped overdue orders count as late; partial dispatch is not in full."),
      card("Quantity Fill by Due Date", fmtRate(r.quantityFill.rate), ratio(r.quantityFill, "units"), "Units dispatched on or before the due date over units ordered, same orders as On-Time In-Full Dispatch."),
      card("On-Time Dispatch Rate", fmtRate(r.onTimeDispatch.rate), ratio(r.onTimeDispatch, "shipments in period"), "Share of shipments dispatched in the period that left on or before their order's due date. Each shipment counts once."),
      card("Past-Due Unshipped Orders", String(r.pastDue.count), `${r.pastDue.unshippedQuantity} units unshipped · ${r.pastDue.partiallyDispatched} partly dispatched`, "Open or partially dispatched orders whose due date has passed, as of the current simulated time."),
      card("Order-to-Final-Dispatch Lead Time", lt.medianMs === null ? "N/A" : fmtDuration(lt.medianMs), lt.count === 0 ? "median · no orders reached final dispatch in period" : `median of ${lt.count} orders · P90 ${fmtDuration(lt.p90Ms!)}`, "Order creation to the dispatch that completed the order, for orders whose final dispatch is in the period. Open orders are excluded, which biases the figure low while many are open."),
    );
    const notes: string[] = [`${lt.openOrders} order${lt.openOrders === 1 ? "" : "s"} still open.`];
    if (r.cancelledInWindow > 0) notes.push(`${r.cancelledInWindow} cancelled order${r.cancelledInWindow === 1 ? "" : "s"} with a due date in the period are excluded.`);
    if (r.indeterminate > 0) notes.push(`${r.indeterminate} shipped order${r.indeterminate === 1 ? "" : "s"} excluded because the final dispatch could not be derived.`);
    setText(this.dispatchNote, notes.join(" "));

    this.pastDueWrap.hidden = r.pastDue.orders.length === 0;
    const pastRows = r.pastDue.orders.slice(0, 50).map((o) => {
      const tr = el("tr", o.orderId === this.selectedCoId ? "clickable selected" : "clickable");
      tr.addEventListener("click", () => this.openEntity({ kind: "customer-order", id: o.orderId }, false));
      tr.append(el("td", undefined, o.orderId), el("td", undefined, o.customerName), el("td", undefined, o.partiallyDispatched ? "Partly dispatched" : "Open"));
      tr.append(el("td", "num", fmtDate(o.dueMs)), el("td", "num", fmtDuration(o.pastDueMs!)), el("td", "num", String(o.unshippedQuantity)), this.workOrderLinks(o));
      return tr;
    });
    if (r.pastDue.orders.length > 50) {
      const tr = el("tr");
      const td = el("td", "hint", `Showing the 50 most overdue of ${r.pastDue.orders.length} past-due orders.`);
      td.colSpan = 7;
      tr.append(td);
      pastRows.push(tr);
    }
    this.pastDueBody.replaceChildren(...pastRows);

    const rows = r.orders.slice().sort(compareByAttention);
    const order = "past-due first, then open by earliest due date, then dispatched";
    setText(this.ordersCount, rows.length > 100 ? `Showing 100 of ${rows.length} orders, ${order}` : `${rows.length} orders, ${order}`);
    const statusText: Record<string, string> = { OPEN: "Open", PARTIALLY_SHIPPED: "Partly dispatched", SHIPPED: "Dispatched", CANCELLED: "Cancelled" };
    this.ordersBody.replaceChildren(
      ...rows.slice(0, 100).map((o) => {
        const tr = el("tr", o.orderId === this.selectedCoId ? "clickable selected" : "clickable");
        tr.addEventListener("click", () => this.openEntity({ kind: "customer-order", id: o.orderId }, false));
        let vsDue = "–";
        if (o.latenessMs !== null) vsDue = o.latenessMs === 0 ? "On time" : `${fmtDuration(o.latenessMs)} late`;
        else if (o.pastDueMs !== null) vsDue = `${fmtDuration(o.pastDueMs)} past due`;
        else if (o.timeToDueMs !== null) vsDue = `${fmtDuration(o.timeToDueMs)} to due`;
        const seg = o.segments
          ? `${fmtDuration(o.segments.toFirstAllocationMs)} to allocation · ${fmtDuration(o.segments.allocationToFirstDispatchMs)} to dispatch · ${fmtDuration(o.segments.firstToFinalDispatchMs)} to final`
          : "N/A";
        tr.append(el("td", undefined, o.orderId), el("td", undefined, o.customerName), el("td", undefined, statusText[o.status] ?? o.status));
        tr.append(el("td", "num", fmtDate(o.createdAtMs)), el("td", "num", fmtDate(o.dueMs)));
        tr.append(el("td", "num", o.finalDispatchMs === null ? "–" : fmtDateTime(o.finalDispatchMs)), el("td", "num", o.leadTimeMs === null ? "–" : fmtDuration(o.leadTimeMs)));
        tr.append(el("td", "num", vsDue), el("td", "num", seg), this.workOrderLinks(o));
        return tr;
      }),
    );
  }

  // ---- quality (S2) -------------------------------------------------------
  // Semantics: docs/KPI_DEFINITIONS.md "Quality, scrap and rework". Built from inspection records only.

  private qualityKey = "";
  private readonly qualityCards = el("div", "ex-kpis");
  private readonly qualityNote = el("p", "hint");
  private readonly paretoBody = el("tbody");
  private readonly causeBody = el("tbody");
  private readonly productBody = el("tbody");
  private readonly stationBody = el("tbody");

  private buildQualityPanel(): HTMLElement {
    const panel = el("section", "ex-panel");
    this.panels.set("quality", panel);
    const tableOf = (headers: string[], body: HTMLElement, numFrom: number) => {
      const tr = el("tr");
      headers.forEach((h, i) => tr.append(el("th", i >= numFrom ? "num" : undefined, h)));
      const thead = el("thead");
      thead.append(tr);
      const t = el("table", "mini-table");
      t.append(thead, body);
      const wrap = el("div", "tbl-scroll");
      wrap.append(t);
      return wrap;
    };
    const groupHeaders = ["", "Inspections", "Units first inspected", "First-pass yield", "Rework rate", "Scrap rate", "Scrap units", "Re-test pass rate"];
    const prodHeaders = groupHeaders.slice();
    prodHeaders[0] = "Product";
    const stHeaders = groupHeaders.slice();
    stHeaders[0] = "QC station";
    panel.append(
      this.qualityCards,
      this.qualityNote,
      el("h3", undefined, "Defect Pareto"),
      tableOf(["Defect", "Defective units", "Share", "Cumulative", ""], this.paretoBody, 1),
      el("h3", undefined, "Failed units by recorded cause"),
      tableOf(["Cause", "Failed units", "Share"], this.causeBody, 1),
      el("h3", undefined, "By product"),
      tableOf(prodHeaders, this.productBody, 1),
      el("h3", undefined, "By QC station"),
      tableOf(stHeaders, this.stationBody, 1),
      el(
        "p",
        "hint",
        "First-pass yield = units passing the first inspection ÷ units first inspected (the dashboard definition). Rework rate = units sent to rework at the first inspection ÷ units first inspected. Scrap rate = units scrapped at any inspection in the period ÷ units first inspected in the period; a re-test scrap in the period may belong to units first inspected earlier. Each failed unit has one recorded defect code. Cause is shown only where the record states one; otherwise it is \"not recorded\", never inferred. Sample sizes are shown beside rates. Synthetic data.",
      ),
    );
    return panel;
  }

  private renderQuality(r: QualityReport): void {
    const o = r.overall;
    const card = (label: string, value: string, scope: string, tip: string) => {
      const c = el("article", "kpi");
      c.title = tip;
      c.append(el("div", "kpi-label", label), el("div", "kpi-value", value), el("div", "kpi-scope", scope));
      return c;
    };
    const of = (x: { numerator: number; denominator: number }, unit: string) => `${x.numerator} / ${x.denominator} ${unit}`;
    this.qualityCards.replaceChildren(
      card("First-pass yield", fmtRate(o.firstPassYield.rate), of(o.firstPassYield, "units first inspected"), "Units passing the first inspection ÷ units first inspected in the period. Same definition as the dashboard KPI."),
      card("Rework rate", fmtRate(o.reworkRate.rate), of(o.reworkRate, "units first inspected"), "Units sent to rework at the first inspection ÷ units first inspected in the period."),
      card("Scrap rate", fmtRate(o.scrapRate.rate), `${o.scrapUnits} scrapped / ${o.firstInspected} units first inspected`, "Units scrapped at any inspection in the period ÷ units first inspected in the period."),
      card("Re-test pass rate", fmtRate(o.retestPassRate.rate), of(o.retestPassRate, "units re-tested"), "Units passing the re-test after rework ÷ units re-tested in the period."),
      card("Defective units", String(o.failedUnits), `${o.inspections} inspections in period`, "Units that failed any inspection in the period; each carries one defect code."),
    );
    setText(this.qualityNote, o.inspections === 0 ? "No inspections were recorded in this period." : "");

    const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
    this.paretoBody.replaceChildren(
      ...r.pareto.map((p) => {
        const tr = el("tr");
        const bar = el("td");
        const fill = el("span", "pareto-bar");
        fill.style.width = `${Math.round(p.share * 100)}%`;
        bar.append(fill);
        tr.append(el("td", undefined, p.code.toLowerCase().replace(/_/g, " ")), el("td", "num", String(p.quantity)), el("td", "num", pct(p.share)), el("td", "num", pct(p.cumulativeShare)), bar);
        return tr;
      }),
    );
    const causeText: Record<string, string> = { MACHINE_FAILURE: "Machine failure", PROCESS_VARIATION: "Process variation", NOT_RECORDED: "Not recorded" };
    this.causeBody.replaceChildren(
      ...r.byCause.map((c) => {
        const tr = el("tr");
        tr.append(el("td", undefined, causeText[c.cause]), el("td", "num", String(c.quantity)), el("td", "num", o.failedUnits > 0 ? pct(c.quantity / o.failedUnits) : "N/A"));
        return tr;
      }),
    );
    const groupRows = (groups: QualityGroup[]) =>
      groups.map((g) => {
        const tr = el("tr");
        tr.append(
          el("td", undefined, g.label),
          el("td", "num", String(g.inspections)),
          el("td", "num", String(g.firstInspected)),
          el("td", "num", fmtRate(g.firstPassYield.rate)),
          el("td", "num", fmtRate(g.reworkRate.rate)),
          el("td", "num", fmtRate(g.scrapRate.rate)),
          el("td", "num", String(g.scrapUnits)),
          el("td", "num", fmtRate(g.retestPassRate.rate)),
        );
        return tr;
      });
    this.productBody.replaceChildren(...groupRows(r.byProduct));
    this.stationBody.replaceChildren(...groupRows(r.byStation));
  }

  // ---- material shortages (S4) ---------------------------------------------
  // Semantics: docs/KPI_DEFINITIONS.md "Material shortage impact". Observed at the current simulated time; no prediction.

  private shortagesKey = "";
  private readonly shortageCards = el("div", "ex-kpis");
  private readonly shortageNote = el("p", "hint");
  private readonly shortageOrdersBody = el("tbody");
  private readonly shortageMaterialsBody = el("tbody");

  private buildShortagesPanel(): HTMLElement {
    const panel = el("section", "ex-panel");
    this.panels.set("shortages", panel);
    const tableOf = (headers: string[], body: HTMLElement, numFrom: number) => {
      const tr = el("tr");
      headers.forEach((h, i) => tr.append(el("th", i >= numFrom ? "num" : undefined, h)));
      const thead = el("thead");
      thead.append(tr);
      const t = el("table", "mini-table");
      t.append(thead, body);
      const wrap = el("div", "tbl-scroll");
      wrap.append(t);
      return wrap;
    };
    panel.append(
      this.shortageCards,
      this.shortageNote,
      el("h3", undefined, "Work orders blocked by a material shortage"),
      tableOf(["Work order", "Product", "Units", "Blocked since", "Short material", "Required", "Available now", "Short by", "Supply on order", "Customer orders"], this.shortageOrdersBody, 2),
      el("h3", undefined, "By material"),
      tableOf(["Material", "Blocked work orders", "Available now", "Outstanding on open POs", "Open POs", "Earliest promised", "POs past promised date"], this.shortageMaterialsBody, 1),
      el(
        "p",
        "hint",
        "Availability is on hand minus reserved in raw storage right now. Supply is the outstanding quantity (ordered minus received) on open purchase orders; \"covers\" means purchase orders taken in promised-date order first reach the shortfall by that date. Blocked orders compete for the same stock and supply and nothing is allocated between them here, so shortfalls of different orders for one material must not be added. A promised date is the supplier's promise, not a forecast of arrival or of when the order will run. Customer orders are the ones the work order was planned for (a planning link). Synthetic data.",
      ),
    );
    return panel;
  }

  private renderShortages(r: MaterialShortageReport): void {
    const blocked = r.blockedOrders;
    const pastDue = blocked.filter((o) => o.earliestCustomerDueMs !== null && o.earliestCustomerDueMs <= r.asOfMs).length;
    const card = (label: string, value: string, scope: string, tip: string) => {
      const c = el("article", "kpi");
      c.title = tip;
      c.append(el("div", "kpi-label", label), el("div", "kpi-value", value), el("div", "kpi-scope", scope));
      return c;
    };
    const noSupply = blocked.flatMap((o) => o.lines).filter((l) => l.supply.status === "NO_SUPPLY").length;
    this.shortageCards.replaceChildren(
      card("Blocked by material shortage", String(blocked.length), "work orders now", "Work orders in status BLOCKED for a material shortage. Equals the dashboard KPI."),
      card("Materials short", String(r.byMaterial.length), "distinct materials", "Materials short for at least one blocked work order at the current balances."),
      card("Short with no supply on order", String(noSupply), "order/material pairs", "Blocked order and material pairs for which no open purchase-order quantity exists."),
      card("Linked to a past-due customer order", String(pastDue), "blocked work orders", "Blocked work orders planned for a customer order whose due date has passed. A planning link, not proven unit flow."),
    );
    setText(this.shortageNote, blocked.length === 0 ? "No work order is blocked by a material shortage at this simulated time." : "");

    const supplyText = (l: MaterialShortageReport["blockedOrders"][number]["lines"][number]) => {
      const s = l.supply;
      if (s.status === "NO_SUPPLY") return "No supply on order";
      const pos = s.purchaseOrderIds.join(", ");
      if (s.status === "NOT_COVERED") return `Not covered: ${s.outstandingQuantity} on order (${pos})`;
      return `Covered by ${fmtDate(s.coverDateMs!)} (${pos})${s.overdue ? " · promised date has passed" : ""}`;
    };
    const rows: HTMLElement[] = [];
    for (const o of blocked) {
      const lines = o.lines.length ? o.lines : [null];
      lines.forEach((l, i) => {
        const tr = el("tr");
        const first = i === 0;
        const wo = el("td");
        if (first) {
          const b = el("button", "link-btn", o.orderId);
          b.addEventListener("click", () => this.openWorkOrder(o.orderId));
          wo.append(b);
        }
        tr.append(wo, el("td", undefined, first ? o.sku : ""), el("td", "num", first ? String(o.quantity) : ""), el("td", "num", first && o.blockedAtMs !== null ? fmtDateTime(o.blockedAtMs) : first ? "–" : ""));
        if (l) {
          tr.append(el("td", undefined, `${l.description} (${l.sku})`), el("td", "num", `${l.required} ${l.uom}`), el("td", "num", String(l.availableNow)), el("td", "num", String(l.shortfall)), el("td", undefined, supplyText(l)));
        } else {
          tr.append(el("td", undefined, "No shortfall at current balances; release is pending"), el("td"), el("td"), el("td"), el("td"));
        }
        const cust = el("td");
        if (first) {
          if (o.customerOrderIds.length === 0) cust.append("–");
          o.customerOrderIds.forEach((cid, ci) => {
            if (ci > 0) cust.append(", ");
            const b = el("button", "link-btn", cid);
            b.addEventListener("click", () => this.openEntity({ kind: "customer-order", id: cid }, false));
            cust.append(b);
          });
          if (o.earliestCustomerDueMs !== null) cust.title = `Earliest customer due date ${fmtDate(o.earliestCustomerDueMs)}`;
        }
        tr.append(cust);
        rows.push(tr);
      });
    }
    this.shortageOrdersBody.replaceChildren(...rows);

    this.shortageMaterialsBody.replaceChildren(
      ...r.byMaterial.map((m) => {
        const tr = el("tr");
        tr.append(
          el("td", undefined, `${m.description} (${m.sku})`),
          el("td", "num", String(m.blockedOrders)),
          el("td", "num", String(m.availableNow)),
          el("td", "num", String(m.outstandingQuantity)),
          el("td", "num", String(m.openPurchaseOrders)),
          el("td", "num", m.earliestPromisedMs === null ? "none on order" : fmtDate(m.earliestPromisedMs)),
          el("td", "num", String(m.overduePurchaseOrders)),
        );
        return tr;
      }),
    );
  }

  private readonly wcBody = el("tbody");
  private readonly eqBody = el("tbody");
  private readonly eqSection = el("div");
  private readonly whySection = el("section", "why-panel");
  private readonly wcShift = el("p", "hint shift-note");
  private wcKey = "";

  private buildWorkCentersPanel(): HTMLElement {
    const panel = el("section", "ex-panel");
    this.panels.set("workcenters", panel);
    const wrap = el("div", "tbl-scroll");
    const t = el("table", "mini-table");
    const head = el("tr");
    const headers = ["Work center", "Stations", "In process (units)", "Queued orders", "Queued units", "Queued std. min / station", "Waiting on equipment", "Oldest wait (shift time)", "Setup min (changeovers)", "Utilization"];
    headers.forEach((h, i) => head.append(el("th", i >= 1 ? "num" : undefined, h)));
    const thead = el("thead");
    thead.append(head);
    t.append(thead, this.wcBody);
    wrap.append(t);
    this.wcShift.hidden = true;
    const eqHead = el("tr");
    ["Equipment", "Kind", "Held by", "Utilization", "Steps waiting"].forEach((h, i) => eqHead.append(el("th", i >= 3 ? "num" : undefined, h)));
    const eqThead = el("thead");
    eqThead.append(eqHead);
    const eqTable = el("table", "mini-table");
    eqTable.append(eqThead, this.eqBody);
    const eqWrap = el("div", "tbl-scroll");
    eqWrap.append(eqTable);
    this.eqSection.append(
      eqWrap,
      el(
        "p",
        "hint",
        "Shared tools are borrowed from a pool for the whole operation, including while the station is down. Utilization = time held ÷ shift minutes in the reporting period. Steps waiting = ready steps that cannot start because every unit of the kind is in use. Setup (changeovers) = setup minutes applied by steps that started in the period, and how many followed a different product at that work center. Synthetic data.",
      ),
    );
    panel.append(
      this.wcShift,
      wrap,
      el(
        "p",
        "hint",
        "Queued = steps ready to start (predecessors complete) that no station has picked up. The flagged work center has the most queued standard minutes per serving station, i.e. where WIP is waiting longest to be served. Utilization = run time ÷ (serving stations × shift minutes) in the reporting period; stations serving several work centers share capacity. Synthetic data.",
      ),
      this.whySection,
      this.eqSection,
    );
    return panel;
  }

  /** Contributing conditions around the flagged work center. Independent observations: not ranked, not added up, not root causes. */
  private renderWhy(e: BottleneckExplanation | null, asOfMs: number): void {
    const items: HTMLElement[] = [];
    if (!e) {
      const off = !inShiftNow(asOfMs);
      this.whySection.replaceChildren(
        el("h3", undefined, "Why a bottleneck candidate?"),
        el("p", "hint", off ? "The plant is off shift, so nothing can start and no work center is flagged." : "No work center has a queue right now, so none is flagged."),
      );
      return;
    }
    const c = e.current;
    const p = e.period;
    const pct = (x: number | null) => (x === null ? "N/A" : `${(x * 100).toFixed(0)}%`);
    const li = (label: string, text: string, tag: "current" | "period" | "plant") => {
      const row = el("li");
      row.append(el("strong", undefined, label), " ", text, " ", el("span", "why-tag", tag === "current" ? "current state" : tag === "period" ? "this period" : "whole plant"));
      items.push(row);
    };
    li(
      "Queue load.",
      `${c.queuedOrders} order${c.queuedOrders === 1 ? "" : "s"} (${c.queuedUnits} units, ${Math.round(c.queuedMinutes)} standard min) wait across ${c.stations} station${c.stations === 1 ? "" : "s"}: ${Math.round(c.queuedMinutesPerStation ?? 0)} min per station` +
        (c.nextHighestPerStation !== null ? `, the next highest work center has ${Math.round(c.nextHighestPerStation)}` : "") +
        (c.oldestWaitMinutes !== null ? `; the longest wait so far is ${c.oldestWaitMinutes} shift min.` : "."),
      "current",
    );
    li(
      "Serving stations.",
      `${c.stationsRunningNow} of ${c.stations} running` + (c.stationsDownNow.length ? `; down now: ${c.stationsDownNow.map((s) => s.name).join(", ")}.` : "; none down."),
      "current",
    );
    li(
      "Equipment.",
      c.waitingOnEquipment > 0 ? `${c.waitingOnEquipment} queued step${c.waitingOnEquipment === 1 ? "" : "s"} cannot start: no free unit of ${c.missingEquipmentKinds.join(", ")}.` : "no queued step is waiting for equipment.",
      "current",
    );
    li(
      "Station downtime.",
      `serving stations were down for ${Math.round(p.stationDowntimeMinutes)} shift min (${pct(p.stationDowntimeShare)} of their shift time).`,
      "period",
    );
    li("Utilization.", `serving stations ran ${pct(p.utilization)} of their shift time (run time excluding failure holds).`, "period");
    li(
      "Changeovers.",
      `${Math.round(p.setupMinutes)} setup min across ${p.changeovers} changeover${p.changeovers === 1 ? "" : "s"}` + (p.setupShareOfBusy === null ? "." : `, ${pct(p.setupShareOfBusy)} of run time.`),
      "period",
    );
    li(
      "Material.",
      e.plant.materialBlockedOrders > 0 ? `${e.plant.materialBlockedOrders} order${e.plant.materialBlockedOrders === 1 ? " is" : "s are"} held before release by a material shortage; they are not in this queue yet.` : "no order is held before release by a material shortage.",
      "plant",
    );
    const list = el("ul", "why-list");
    list.append(...items);
    this.whySection.replaceChildren(
      el("h3", undefined, `Why is ${e.name} the bottleneck candidate? Contributing conditions`),
      list,
      el(
        "p",
        "hint",
        "These are independent observations around the flagged work center, listed in a fixed order, not by importance. They can all be true at once, so they must not be added up or read as shares of the delay, and they are indicative context rather than proven root causes. Current-state items describe the simulated moment shown above, not a history. The flag itself means only that this work center has the most queued standard minutes per serving station.",
      ),
    );
  }

  private renderEquipment(rows: ReturnType<typeof equipmentLoad>): void {
    this.eqSection.hidden = rows.length === 0;
    this.eqBody.replaceChildren(
      ...rows.map((r) => {
        const tr = el("tr");
        tr.append(el("td", undefined, r.name), el("td", undefined, r.kind), el("td", undefined, r.heldByOrderId ?? "free"));
        tr.append(el("td", "num", r.utilization === null ? "N/A" : `${(r.utilization * 100).toFixed(0)}%`), el("td", "num", String(r.stepsWaiting)));
        return tr;
      }),
    );
  }

  private renderWorkCenters(rows: ReturnType<typeof workCenterLoad>, asOfMs: number): void {
    const open = rows[0]?.shiftOpen ?? true;
    this.wcShift.hidden = open;
    if (!open) {
      const next = nextShiftStart(asOfMs);
      setText(
        this.wcShift,
        `Off shift: nothing starts until ${weekdayShort(next)} ${new Date(next).toISOString().slice(0, 10)} 06:00 UTC. Queued steps are waiting for the shift, not for a station, so no bottleneck is flagged.`,
      );
    }
    const fmtWait = (m: number | null) => (m === null ? "–" : m >= 120 ? `${(m / 60).toFixed(1)} h` : `${m} min`);
    this.wcBody.replaceChildren(
      ...rows.map((r) => {
        const tr = el("tr", r.isBottleneck ? "bottleneck" : undefined);
        const name = el("td");
        name.append(r.name);
        if (r.isBottleneck) name.append(" ", el("span", "demo-badge", "Bottleneck"));
        tr.append(name);
        const cells = [
          String(r.stationIds.length),
          String(r.inProcessUnits),
          String(r.queuedOrders),
          String(r.queuedUnits),
          r.queuedMinutesPerStation === null ? "N/A" : String(Math.round(r.queuedMinutesPerStation)),
          String(r.waitingOnEquipment),
          fmtWait(r.oldestWaitMinutes),
          `${r.setupMinutes} (${r.changeovers})`,
          r.utilization === null ? "N/A" : `${(r.utilization * 100).toFixed(0)}%`,
        ];
        for (const c of cells) tr.append(el("td", "num", c));
        return tr;
      }),
    );
  }

  private buildInventoryPanel(): HTMLElement {
    const panel = el("section", "ex-panel");
    this.panels.set("inventory", panel);
    const box = el("div", "empty-state big");
    box.append(el("strong", undefined, "Coming soon"), el("p", undefined, "Inventory reporting is planned for a future release."));
    panel.append(box);
    return panel;
  }

  // ---- work order table --------------------------------------------------

  private tableDirty = true;
  private dirtyTable(): void {
    this.tableDirty = true;
    this.update(true);
  }

  private filtered(): WorkOrderSummary[] {
    const q = this.search;
    const out = this.summaries.filter((s) => {
      if (this.statusFilter === "BLOCKED") {
        if (s.status !== "BLOCKED") return false;
      } else if (this.statusFilter !== "ALL" && s.category !== this.statusFilter) return false;
      if (!q) return true;
      return (
        s.id.toLowerCase().includes(q) ||
        s.productName.toLowerCase().includes(q) ||
        s.sku.toLowerCase().includes(q) ||
        s.customerOrderIds.some((c) => c.toLowerCase().includes(q))
      );
    });
    const cmp = SORTERS[this.sortKey];
    const dir = this.sortDir;
    return out.sort((a, b) => dir * cmp(a, b) || a.id.localeCompare(b.id));
  }

  private rowCells(s: WorkOrderSummary): { sig: string; fill: (cells: HTMLTableCellElement[]) => void } {
    const customer = s.customerOrderIds.length ? s.customerOrderIds.join(", ") : "N/A";
    const statusText =
      s.status === "BLOCKED"
        ? s.blockReason === "MATERIAL_SHORTAGE"
          ? "Blocked – material"
          : "Blocked – machine down"
        : STATUS_TEXT[s.status];
    const op = s.currentOperation
      ? `${s.currentOperation.label}${s.currentOperation.workstationName ? ` @ ${s.currentOperation.workstationName}` : ""}`
      : "—";
    const pct = Math.round(s.progress * 100);
    const sig = [s.status, s.blockReason, s.goodQuantity, statusText, op, pct, customer, s.orderedQuantity].join("|");
    return {
      sig,
      fill: (c) => {
        setText(c[0], s.id);
        setText(c[1], `${s.productName} · ${s.sku}`);
        setText(c[2], customer);
        setText(c[3], String(s.orderedQuantity));
        setText(c[4], String(s.goodQuantity));
        c[5].replaceChildren(statusBadge(s.status, statusText));
        setText(c[6], op);
        setText(c[7], fmtDate(s.createdAt));
        setText(c[8], fmtDate(s.dueDate));
        const bar = el("span", "pbar");
        const fill = el("span", "pfill");
        fill.style.width = `${pct}%`;
        bar.append(fill);
        c[9].replaceChildren(bar, document.createTextNode(` ${pct}%`));
      },
    };
  }

  private renderTable(): void {
    this.tableDirty = false;
    const list = this.filtered();
    const shown = list.slice(0, this.visibleLimit);

    // header sort indicators
    for (const [k, th] of this.headerCells) {
      const col = COLUMNS.find((c) => c.key === k)!;
      const arrow = k === this.sortKey ? (this.sortDir === 1 ? " ▲" : " ▼") : "";
      setText(th, col.label + arrow);
      th.setAttribute("aria-sort", k === this.sortKey ? (this.sortDir === 1 ? "ascending" : "descending") : "none");
    }

    setText(
      this.resultCount,
      list.length === this.summaries.length
        ? `${list.length} work orders`
        : `${list.length} of ${this.summaries.length} work orders`,
    );

    const ids = shown.map((s) => s.id);
    const nextRows = new Map<string, RowEntry>();
    for (const s of shown) {
      let entry = this.rows.get(s.id);
      if (!entry) {
        const tr = el("tr", "clickable");
        tr.dataset.id = s.id;
        const cells = COLUMNS.map((c) => el("td", c.numeric ? "num" : undefined));
        tr.append(...cells);
        entry = { tr, cells, sig: "" };
      }
      const { sig, fill } = this.rowCells(s);
      if (entry.sig !== sig) {
        fill(entry.cells);
        entry.sig = sig;
      }
      entry.tr.classList.toggle("selected", s.id === this.selectedId);
      nextRows.set(s.id, entry);
    }
    this.rows.clear();
    for (const [k, v] of nextRows) this.rows.set(k, v);

    const sameOrder =
      ids.length === this.renderedOrder.length && ids.every((id, i) => id === this.renderedOrder[i]);
    if (!sameOrder) {
      this.tbody.replaceChildren(...shown.map((s) => nextRows.get(s.id)!.tr));
      this.renderedOrder = ids;
    }

    if (list.length === 0) {
      this.empty.hidden = false;
      this.empty.textContent =
        this.summaries.length === 0
          ? "No production orders exist yet at this simulated time."
          : "No work orders match the current search and status filter.";
    } else {
      this.empty.hidden = true;
    }
    this.more.hidden = list.length <= shown.length;
    if (!this.more.hidden) this.more.textContent = `Show more (${list.length - shown.length} remaining)`;
  }

  // ---- detail ------------------------------------------------------------

  /** Show a work order's detail drawer from outside the Explorer (e.g. a selected 3D station). */
  openWorkOrder(id: string): void {
    this.openEntity({ kind: "work-order", id }, false);
  }

  /**
   * Open a work order or customer order in its drawer. `fromLink` is true when the user followed a link inside a drawer: the entity
   * they came from is remembered so Back returns to it. Otherwise the trail restarts.
   */
  openEntity(ref: EntityRef, fromLink: boolean): void {
    const current: EntityRef | null = this.selectedId && this.drawer.isOpen ? { kind: "work-order", id: this.selectedId } : this.selectedCoId && this.coDrawer.isOpen ? { kind: "customer-order", id: this.selectedCoId } : null;
    if (fromLink && current) this.trail.push(current);
    else if (!fromLink) this.trail = [];
    this.drawer.hide();
    this.coDrawer.hide();
    if (ref.kind === "work-order") {
      this.selectedCoId = null;
      this.selectedId = ref.id;
      this.showTab("orders");
      for (const [rid, r] of this.rows) r.tr.classList.toggle("selected", rid === ref.id);
    } else {
      this.selectedId = null;
      this.selectedCoId = ref.id;
      this.showTab("dispatch");
      this.dispatchKey = "";
    }
    this.drawerKey = "";
    this.coDrawerKey = "";
    this.drawer.setBackVisible(this.trail.length > 0);
    this.coDrawer.setBackVisible(this.trail.length > 0);
    this.update(true);
    this.notifyRoute();
  }

  private goBack(): void {
    const prev = this.trail.pop();
    if (!prev) return;
    const keep = this.trail.slice();
    this.openEntity(prev, false);
    this.trail = keep;
    this.drawer.setBackVisible(keep.length > 0);
    this.coDrawer.setBackVisible(keep.length > 0);
  }

  private openDetail(id: string): void {
    this.openEntity({ kind: "work-order", id }, false);
  }

  private closeDetail(): void {
    this.selectedId = null;
    this.drawer.hide();
    this.drawerKey = "";
    this.trail = [];
    for (const r of this.rows.values()) r.tr.classList.remove("selected");
    this.notifyRoute();
  }

  private closeCustomerOrder(): void {
    this.selectedCoId = null;
    this.coDrawer.hide();
    this.coDrawerKey = "";
    this.trail = [];
    this.dispatchKey = "";
    this.update(true);
    this.notifyRoute();
  }

  // ---- deep links (S5) -----------------------------------------------------

  /** What is on screen: the active tab and the selected entity, if its drawer belongs to that tab. */
  route(): { tab: ExplorerTab; entity?: EntityRef } {
    if (this.tab === "orders" && this.selectedId) return { tab: this.tab, entity: { kind: "work-order", id: this.selectedId } };
    if (this.tab === "dispatch" && this.selectedCoId) return { tab: this.tab, entity: { kind: "customer-order", id: this.selectedCoId } };
    return { tab: this.tab };
  }

  /** Called whenever `route()` may have changed. */
  onRouteChange(listener: () => void): void {
    this.routeListener = listener;
  }

  private notifyRoute(): void {
    this.routeListener?.();
  }

  /** Show a route's tab and entity (from a URL). A tab-only route clears the selection on that tab. */
  applyRoute(tab: ExplorerTab, entity?: EntityRef): void {
    if (entity && entityTab(entity) === tab) {
      this.openEntity(entity, false);
      return;
    }
    this.trail = [];
    if (tab === "orders" && this.selectedId) this.closeDetail();
    if (tab === "dispatch" && this.selectedCoId) this.closeCustomerOrder();
    this.showTab(tab);
    this.update(true);
  }

  private renderDrawer(changed: boolean): void {
    if (!this.selectedId) return;
    if (!changed && this.drawerKey !== "") return;
    const snap = reportingSnapshot(this.sim);
    const detail = workOrderDetail(snap, this.selectedId);
    this.drawerKey = this.dataKey;
    if (detail) this.drawer.render(detail, workOrderTime(snap, this.selectedId));
    else this.drawer.renderMissing(this.selectedId);
  }

  private renderCoDrawer(changed: boolean): void {
    if (!this.selectedCoId) return;
    if (!changed && this.coDrawerKey !== "") return;
    const snap = reportingSnapshot(this.sim);
    const detail = customerOrderDetail(snap, this.selectedCoId);
    this.coDrawerKey = this.dataKey;
    if (detail) this.coDrawer.render(detail);
    else this.coDrawer.renderMissing(this.selectedCoId);
  }
}
