import type { ReportingSnapshot } from "../analytics/types";
import type { SimulationController } from "./SimulationController";

let cached: { engine: unknown; position: number; epoch: number; events: ReportingSnapshot["events"] } | null = null;

/**
 * Build the reporting input from the one simulation clock/engine. The applied
 * event list is only re-sliced when events were applied or history was discarded.
 */
export function reportingSnapshot(sim: SimulationController): ReportingSnapshot {
  const position = sim.eventsApplied;
  if (!cached || cached.engine !== sim.engine || cached.position !== position || cached.epoch !== sim.epoch) {
    cached = { engine: sim.engine, position, epoch: sim.epoch, events: sim.engine.appliedEvents() };
  }
  return {
    asOfMs: sim.currentTime.getTime(),
    startMs: sim.startTime.getTime(),
    master: sim.engine.master,
    state: sim.state,
    events: cached.events,
  };
}
