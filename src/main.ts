import "./style.css";
import { SceneManager } from "./graphics/SceneManager";
import { SimulationController } from "./simulation/SimulationController";
import { loadSimulationData } from "./simulation/loadSimulationData";
import { Dashboard } from "./ui/Dashboard";
import { OperationsExplorer } from "./ui/explorer/OperationsExplorer";
import { el } from "./ui/dom";
import { formatRoute, parseRoute, type Route } from "./ui/route";

/** Replace the page with a readable error instead of leaving it blank. */
function showFatal(container: HTMLElement | null, title: string, detail: string): void {
  const box = el("div", "fatal");
  box.setAttribute("role", "alert");
  box.append(el("h2", undefined, title), el("p", undefined, detail));
  (container ?? document.body).replaceChildren(box);
}

async function main() {
  const container = document.querySelector<HTMLDivElement>("#app");

  if (!container) {
    throw new Error("App container not found");
  }

  // 1. Load manufacturing data
  let data: Awaited<ReturnType<typeof loadSimulationData>>;
  try {
    data = await loadSimulationData();
  } catch (err) {
    showFatal(
      container,
      "Could not load manufacturing data",
      `${err instanceof Error ? err.message : String(err)}. Check your connection and reload the page.`,
    );
    throw err;
  }
  const { initial, events } = data;

  // 2. Create the simulation (the single simulation clock)
  const simulation = new SimulationController(initial, events);

  // 3. Build the dashboard shell, then mount the Three.js scene in its viewport
  const dashboard = new Dashboard(container, simulation);

  // WebGL can be unavailable; keep the dashboard and Explorer usable without the 3D view.
  let scene: SceneManager | null = null;
  try {
    scene = new SceneManager(dashboard.layout.viewport, simulation, {
      onSelectionChange: (id) => dashboard.setSelected(id),
      getPeriod: () => dashboard.reportingPeriod,
    });
    const s = scene;
    dashboard.attachSelection(s.details, (id) => s.select(id));
  } catch (err) {
    console.error(err);
    const note = el("div", "fatal inline");
    note.append(
      el("h2", undefined, "3D view unavailable"),
      el("p", undefined, "WebGL could not be initialised in this browser. The KPIs, playback and Operations Explorer still work."),
    );
    dashboard.layout.viewport.replaceChildren(note);
    // No render loop owns the clock now, so drive the same simulation from a minimal loop.
    let last = performance.now();
    const tick = (now: number) => {
      simulation.update((now - last) / 1000);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // 4. Operations Explorer: same simulation, same refresh timer, no second clock.
  const explorer = new OperationsExplorer(simulation, () => dashboard.reportingPeriod);
  container.append(explorer.element);
  dashboard.onRefresh(() => explorer.update());
  dashboard.onPeriodChange(() => {
    explorer.update(true);
    scene?.refreshVisuals();
  });
  if (scene) {
    const s = scene;
    explorer.setFactoryLink((ids, mode) => {
      show("overview");
      s.focus(ids, mode);
    });
  }

  scene?.details.onOpenWorkOrder((id) => {
    show("explorer");
    explorer.openWorkOrder(id);
  });

  type ViewId = "overview" | "explorer";
  const tabs = new Map<ViewId, HTMLButtonElement>();
  let activeView: ViewId = "overview";
  const show = (view: ViewId) => {
    activeView = view;
    scene?.setActive(view === "overview");
    dashboard.setOverviewActive(view === "overview");
    explorer.setActive(view === "explorer");
    for (const [id, b] of tabs) {
      b.classList.toggle("active", id === view);
      b.setAttribute("aria-current", id === view ? "page" : "false");
    }
    syncRoute();
  };

  // Deep links: the URL hash records the view, Explorer tab and selected work order or customer order (not simulated time).
  const currentRoute = (): Route => (activeView === "overview" ? { view: "overview" } : { view: "explorer", ...explorer.route() });
  function syncRoute(): void {
    const hash = formatRoute(currentRoute());
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }
  const applyRoute = (r: Route | null): void => {
    if (!r) return;
    if (formatRoute(currentRoute()) === formatRoute(r)) return;
    if (r.view === "overview") show("overview");
    else {
      show("explorer");
      explorer.applyRoute(r.tab, r.entity);
    }
  };
  explorer.onRouteChange(syncRoute);
  window.addEventListener("hashchange", () => applyRoute(parseRoute(location.hash)));
  for (const [id, label] of [
    ["overview", "Factory Overview"],
    ["explorer", "Operations Explorer"],
  ] as const) {
    const b = el("button", "nav-tab", label);
    b.addEventListener("click", () => show(id));
    tabs.set(id, b);
    dashboard.layout.nav.append(b);
  }
  const roadmapLink = el("a", "nav-tab", "Roadmap");
  roadmapLink.setAttribute("href", "/roadmap/index.html");
  roadmapLink.style.textDecoration = "none";
  dashboard.layout.nav.append(roadmapLink);
  const initialRoute = parseRoute(location.hash); // read before the first show() rewrites the hash
  show("overview");
  applyRoute(initialRoute);

  simulation.setSpeed(3600);

  // 5. Start the simulation
  simulation.play();
  dashboard.refresh();
}

main().catch((err) => {
  console.error(err);
  const container = document.querySelector<HTMLElement>("#app");
  if (container && !container.querySelector(".fatal") && !container.querySelector(".topbar")) {
    showFatal(container, "FactoryFlow failed to start", err instanceof Error ? err.message : String(err));
  }
});
