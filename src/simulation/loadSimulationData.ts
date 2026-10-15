import type { FactoryEvent, InitialStateFile } from "../manufacturing/types";

export async function loadSimulationData() {
  const [initialResponse, eventsResponse] = await Promise.all([
    fetch("/data/initial_state.json"),
    fetch("/data/events.json"),
  ]);

  if (!initialResponse.ok || !eventsResponse.ok) {
    throw new Error("Failed to load simulation data");
  }

  const initial = (await initialResponse.json()) as InitialStateFile;

  const events = (await eventsResponse.json()) as FactoryEvent[];

  return { initial, events };
}
