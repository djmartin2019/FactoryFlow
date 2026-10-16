/**
 * Operations Explorer: full-page, read-only reporting view.
 *
 * It owns no simulation state or clock. Each refresh it asks the shared
 * SimulationController for a snapshot and re-derives reporting data only when
 * events were applied (or history was reset/sought), throttled to REFRESH_MS.
 */
import {
  PERIODS,
  goodUnitsThroughput,
  workOrderCounts,
  workOrderDetail,
  workOrderSummaries,
  type PeriodId,
  type WorkOrderCategory,
  type WorkOrderSummary,
} from "../../analytics";
import { reportingSnapshot } from "../../simulation/reportingSnapshot";
import type { SimulationController } from "../../simulation/SimulationController";
import { el, formatSimTime, setText } from "../dom";
import { fmtDate, statusBadge, STATUS_TEXT } from "./format";
import { ThroughputChart } from "./ThroughputChart";
import { WorkOrderDrawer } from "./WorkOrderDrawer";

const REFRESH_MS = 500;
const PAGE_SIZE = 100;

type Tab = "orders" | "analytics" | "inventory";
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
  private readonly chart = new ThroughputChart();
  private readonly productSelect = el("select", "ctl");
  private drawerKey = "";

  private readonly cleanup: Array<() => void> = [];

  constructor(sim: SimulationController, getPeriod: () => PeriodId) {
    this.sim = sim;
    this.getPeriod = getPeriod;
    this.drawer = new WorkOrderDrawer(() => this.closeDetail());

    this.element.append(this.buildHeader(), this.buildTabs(), this.buildOrdersPanel(), this.buildAnalyticsPanel(), this.buildInventoryPanel(), this.drawer.element);
    this.element.hidden = true;
    this.showTab("orders");

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && this.active && this.drawer.isOpen) this.closeDetail();
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
      ["analytics", "Production Analytics"],
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
    this.showTab("orders");
    this.openDetail(id);
  }

  private openDetail(id: string): void {
    this.selectedId = id;
    this.drawerKey = "";
    for (const [rid, r] of this.rows) r.tr.classList.toggle("selected", rid === id);
    this.update(true);
  }

  private closeDetail(): void {
    this.selectedId = null;
    this.drawer.hide();
    this.drawerKey = "";
    for (const r of this.rows.values()) r.tr.classList.remove("selected");
  }

  private renderDrawer(changed: boolean): void {
    if (!this.selectedId) return;
    if (!changed && this.drawerKey !== "") return;
    const snap = reportingSnapshot(this.sim);
    const detail = workOrderDetail(snap, this.selectedId);
    this.drawerKey = this.dataKey;
    if (detail) this.drawer.render(detail);
    else this.drawer.renderMissing(this.selectedId);
  }
}
