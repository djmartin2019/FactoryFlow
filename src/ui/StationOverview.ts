import type { StationMetrics } from "../manufacturing/dashboardMetrics";
import { STATUS_HEX, STATUS_LABEL, el, formatPct, setText } from "./dom";

interface Row {
  tr: HTMLTableRowElement;
  dot: HTMLElement;
  status: HTMLElement;
  order: HTMLElement;
  queue: HTMLElement;
  util: HTMLElement;
}

export class StationOverview {
  readonly element = el("section", "panel overview");
  private readonly body = el("tbody");
  private readonly rows = new Map<string, Row>();

  private readonly onSelect: (id: string) => void;

  constructor(onSelect: (id: string) => void) {
    this.onSelect = onSelect;
    const table = el("table");
    const head = el("thead");
    const tr = el("tr");
    for (const h of ["Station", "Status", "Work order", "Queue", "Util."]) tr.appendChild(el("th", undefined, h));
    head.appendChild(tr);
    table.append(head, this.body);
    this.element.append(el("h2", undefined, "Workstations"), table);
  }

  update(stations: StationMetrics[], selectedId: string | null): void {
    for (const s of stations) {
      let row = this.rows.get(s.workstationId);
      if (!row) {
        row = this.createRow(s);
        this.rows.set(s.workstationId, row);
        this.body.appendChild(row.tr);
      }
      row.dot.style.background = STATUS_HEX[s.objectStatus];
      setText(row.status, STATUS_LABEL[s.objectStatus]);
      setText(row.order, s.currentOrderId ?? "—");
      setText(row.queue, String(s.queueLength));
      setText(row.util, formatPct(s.utilization));
      row.tr.classList.toggle("selected", s.workstationId === selectedId);
    }
  }

  private createRow(s: StationMetrics): Row {
    const tr = el("tr", "clickable");
    tr.tabIndex = 0;
    const name = el("td", undefined, s.name);
    name.title = s.workstationId;
    const statusCell = el("td", "status-cell");
    const dot = el("span", "dot");
    const status = el("span");
    statusCell.append(dot, status);
    const order = el("td");
    const queue = el("td", "num");
    const util = el("td", "num");
    tr.append(name, statusCell, order, queue, util);
    const select = () => this.onSelect(s.workstationId);
    tr.addEventListener("click", select);
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        select();
      }
    });
    return { tr, dot, status, order, queue, util };
  }
}
