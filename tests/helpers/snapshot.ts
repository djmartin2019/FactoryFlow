/**
 * Shared `ReportingSnapshot` builders for tests. Replays through the real `FactoryReplay` so every test
 * sees the same state/events pairing the app does; the literal builder is for hand-made snapshots.
 */
import type { ReportingSnapshot } from "../../src/analytics/index.ts";
import { FactoryReplay } from "../../src/manufacturing/replay.ts";
import type { FactoryEvent, InitialStateFile, ManufacturingDataset } from "../../src/manufacturing/types.ts";

export function initialFileOf(d: ManufacturingDataset): InitialStateFile {
  return { schemaVersion: d.manifest.schemaVersion, master: d.master, state: d.initialState };
}

/** Snapshot after applying every event with timestamp <= `ms`. */
export function snapshotAt(initial: InitialStateFile, events: FactoryEvent[], ms: number): ReportingSnapshot {
  const r = new FactoryReplay(structuredClone(initial), events);
  r.advanceToMs(ms);
  return { asOfMs: ms, startMs: Date.parse(initial.state.asOf), master: initial.master, state: r.state, events: r.appliedEvents() };
}

/** Snapshot at the timestamp of the last event. */
export function endSnapshot(initial: InitialStateFile, events: FactoryEvent[]): ReportingSnapshot {
  return snapshotAt(initial, events, Date.parse(events[events.length - 1].timestamp));
}

/** Hand-built snapshot: `startMs` defaults to the initial state's `asOf`. */
export function literalSnapshot(
  initial: InitialStateFile,
  fields: Pick<ReportingSnapshot, "asOfMs" | "events"> & Partial<ReportingSnapshot>,
): ReportingSnapshot {
  return { startMs: Date.parse(initial.state.asOf), master: initial.master, state: initial.state, ...fields };
}
