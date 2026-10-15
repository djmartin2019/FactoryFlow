import type { FactoryEvent, InitialStateFile } from "../manufacturing/types";

export async function loadSimulationData() {
  const [initialResponse, eventsResponse] = await Promise.all([
    fetch("/data/initial_state.json"),
    fetch("/data/events.json"),
  ]);

  for (const r of [initialResponse, eventsResponse]) {
    if (!r.ok) throw new Error(`Failed to load ${new URL(r.url, location.href).pathname} (HTTP ${r.status})`);
  }

  const initial = (await initialResponse.json()) as InitialStateFile;

  const events = (await eventsResponse.json()) as FactoryEvent[];

  return { initial, events };
}
