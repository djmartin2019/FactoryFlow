import "./style.css";
import { SceneManager } from "./graphics/SceneManager";
import { SimulationController } from "./simulation/SimulationController";
import { loadSimulationData } from "./simulation/loadSimulationData";
import { Dashboard } from "./ui/Dashboard";

async function main() {
  const container = document.querySelector<HTMLDivElement>("#app");

  if (!container) {
    throw new Error("App container not found");
  }

  // 1. Load manufacturing data
  const { initial, events } = await loadSimulationData();

  // 2. Create the simulation (the single simulation clock)
  const simulation = new SimulationController(initial, events);

  // 3. Build the dashboard shell, then mount the Three.js scene in its viewport
  const dashboard = new Dashboard(container, simulation);

  const scene = new SceneManager(dashboard.layout.viewport, simulation, {
    onSelectionChange: (id) => dashboard.setSelected(id),
  });

  dashboard.attachSelection(scene.details, (id) => scene.select(id));

  simulation.setSpeed(3600);

  // 4. Start the simulation
  simulation.play();
  dashboard.refresh();
}

main().catch(console.error);
