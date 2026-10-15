/**
 * Dashboard shell: wires simulation state to the DOM components.
 * Owns a throttled refresh loop that is independent of the Three.js
 * animation loop; the simulation clock itself is never duplicated here.
 */
import type { SimulationController } from "../simulation/SimulationController";
import {
  computeKpis,
  periodWindow,
  stationMetrics,
  type PeriodId,
  type StationMetrics,
} from "../manufacturing/dashboardMetrics";
import { ActivityLog, describeEvent, type FeedEntry } from "../manufacturing/eventFormat";
import { ActivityFeed } from "./ActivityFeed";
import { KpiCards } from "./KpiCards";
import { PlaybackToolbar } from "./PlaybackToolbar";
import { StationOverview } from "./StationOverview";
import type StationDetails from "./StationDetails";
import { el } from "./dom";

const REFRESH_MS = 250;

export interface DashboardLayout {
  /** Element the Three.js scene should be mounted into. */
  viewport: HTMLElement;
  /** Persistent top bar (title, navigation, playback). */
  header: HTMLElement;
  /** Wrapper around the KPI row + 3D viewport + sidebar; hidden in other views. */
  overview: HTMLElement;
  /** Navigation slot inside the header. */
  nav: HTMLElement;
}

export class Dashboard {
  readonly layout: DashboardLayout;

  private readonly log = new ActivityLog(200);
  private readonly kpis: KpiCards;
  private readonly toolbar: PlaybackToolbar;
  private readonly feed: ActivityFeed;
  private readonly overview: StationOverview;
  private period: PeriodId = "24h";
  private stations: StationMetrics[] = [];
  private selectedId: string | null = null;
  private details: StationDetails | null = null;
  private selectHandler: (id: string) => void = () => {};
  private timer: number | undefined;
  private unsubscribe: () => void;
  private overviewActive = true;
  private refreshListeners = new Set<() => void>();
  private periodListeners = new Set<(p: PeriodId) => void>();

  private readonly simulation: SimulationController;

  constructor(root: HTMLElement, simulation: SimulationController) {
    this.simulation = simulation;
    const master = simulation.engine.master;

    this.toolbar = new PlaybackToolbar(simulation, () => this.refresh());
    this.kpis = new KpiCards((p) => {
      this.period = p;
      for (const l of this.periodListeners) l(p);
      this.refresh();
    });
    this.overview = new StationOverview((id) => this.selectHandler(id));
    this.feed = new ActivityFeed(this.log, (entry: FeedEntry) => {
      const id = entry.objectIds[0];
      if (id) this.selectHandler(id);
    });

    const header = el("header", "topbar");
    const title = el("div", "title");
    title.append(el("h1", undefined, "FactoryFlow"), el("span", "demo-badge", "Demo Mode — Synthetic Manufacturing Data"));
    const periodWrap = el("label", "period", "KPI period ");
    periodWrap.appendChild(this.kpis.periodSelect);
    const nav = el("nav", "app-nav");
    header.append(title, nav, this.toolbar.element, periodWrap);

    const viewport = el("div", "viewport");
    const side = el("aside", "sidebar");
    side.append(this.overview.element, this.feed.element);
    const main = el("main", "main");
    main.append(viewport, side);

    const overview = el("div", "view view-overview");
    overview.append(this.kpis.element, main);
    root.append(header, overview);
    this.layout = { viewport, header, overview, nav };

    // Capture every applied event; replay listeners survive reset/seek.
    this.unsubscribe = simulation.engine.onEvent((event) => {
      this.log.push(describeEvent(event, master), this.simulation.epoch);
    });

    this.refresh();
    this.timer = window.setInterval(() => {
      if (!document.hidden) this.refresh();
    }, REFRESH_MS);
  }

  /** Called by the scene when selection changes (canvas click or programmatic). */
  attachSelection(details: StationDetails, select: (id: string) => void): void {
    this.details = details;
    this.selectHandler = select;
    details.setContext(() => ({
      state: this.simulation.state,
      master: this.simulation.engine.master,
      stations: this.stations,
      log: this.log,
    }));
  }

  setSelected(id: string | null): void {
    this.selectedId = id;
    this.refresh();
  }

  get reportingPeriod(): PeriodId {
    return this.period;
  }

  /** Shared period selection; fires when the header selector changes. */
  onPeriodChange(cb: (p: PeriodId) => void): () => void {
    this.periodListeners.add(cb);
    return () => this.periodListeners.delete(cb);
  }

  /** Fires after every refresh tick (single shared timer; consumers throttle themselves). */
  onRefresh(cb: () => void): () => void {
    this.refreshListeners.add(cb);
    return () => this.refreshListeners.delete(cb);
  }

  /** The overview skips its KPI/station/feed work while another view is shown. */
  setOverviewActive(active: boolean): void {
    this.overviewActive = active;
    this.layout.overview.hidden = !active;
    if (active) this.refresh();
  }

  refresh(): void {
    const sim = this.simulation;
    const master = sim.engine.master;
    this.toolbar.update();
    if (!this.overviewActive) {
      for (const l of this.refreshListeners) l();
      return;
    }
    this.log.sync(sim.epoch);

    const win = periodWindow(this.period, sim.currentTime.getTime(), sim.startTime.getTime());
    this.stations = stationMetrics(sim.state, master, win);
    this.kpis.update(computeKpis(sim.state, master, win, this.stations));
    this.overview.update(this.stations, this.selectedId);
    this.feed.update();
    this.details?.refresh();
    for (const l of this.refreshListeners) l();
  }

  dispose(): void {
    window.clearInterval(this.timer);
    this.unsubscribe();
    this.refreshListeners.clear();
    this.periodListeners.clear();
  }
}
