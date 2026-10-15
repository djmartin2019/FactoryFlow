import "./style.css";
import { SceneManager } from "./graphics/SceneManager";
import { SimulationController } from "./simulation/SimulationController";
import { loadSimulationData } from "./simulation/loadSimulationData";
import { Dashboard } from "./ui/Dashboard";
import { OperationsExplorer } from "./ui/explorer/OperationsExplorer";
import { el } from "./ui/dom";

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
  dashboard.onPeriodChange(() => explorer.update(true));

  type ViewId = "overview" | "explorer";
  const tabs = new Map<ViewId, HTMLButtonElement>();
  const show = (view: ViewId) => {
    scene?.setActive(view === "overview");
    dashboard.setOverviewActive(view === "overview");
    explorer.setActive(view === "explorer");
    for (const [id, b] of tabs) {
      b.classList.toggle("active", id === view);
      b.setAttribute("aria-current", id === view ? "page" : "false");
    }
  };
  for (const [id, label] of [
    ["overview", "Factory Overview"],
    ["explorer", "Operations Explorer"],
  ] as const) {
    const b = el("button", "nav-tab", label);
    b.addEventListener("click", () => show(id));
    tabs.set(id, b);
    dashboard.layout.nav.append(b);
  }
  show("overview");

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
