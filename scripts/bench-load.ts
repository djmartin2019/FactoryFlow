/**
 * Load-pipeline baseline for docs/PERFORMANCE.md (M0 of the source integration plan).
 * Measures the work the app does once at load plus the cost the reducer redesign must beat or ignore.
 *   node scripts/bench-load.ts
 * Wall-clock numbers are indicative only and deliberately not asserted anywhere.
 */
import { readFileSync, statSync } from "node:fs";
import { FactoryReplay } from "../src/manufacturing/replay.ts";
import type { FactoryEvent, FactoryState, InitialStateFile } from "../src/manufacturing/types.ts";

const dir = new URL("../data/generated/", import.meta.url);
const eventsText = readFileSync(new URL("events.json", dir), "utf8");
const initialText = readFileSync(new URL("initial_state.json", dir), "utf8");
const finalText = readFileSync(new URL("final_state.json", dir), "utf8");

const RUNS = 5;

function time<T>(fn: () => T): { ms: number; value: T } {
  const t0 = performance.now();
  const value = fn();
  return { ms: performance.now() - t0, value };
}

function mean(label: string, fn: () => unknown, warmup = 1): number {
  for (let i = 0; i < warmup; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) samples.push(time(fn).ms);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  console.log(`${label.padEnd(44)} mean ${avg.toFixed(1).padStart(7)} ms  (min ${Math.min(...samples).toFixed(1)}, max ${Math.max(...samples).toFixed(1)})`);
  return avg;
}

const initial: InitialStateFile = JSON.parse(initialText);
const events: FactoryEvent[] = JSON.parse(eventsText);
const finalState: FactoryState = JSON.parse(finalText);

console.log(`node ${process.version}; events ${events.length}; events.json ${(statSync(new URL("events.json", dir)).size / 1e6).toFixed(2)} MB`);
mean("JSON.parse(events.json)", () => JSON.parse(eventsText));
mean("JSON.parse(initial_state.json)", () => JSON.parse(initialText));
mean("new FactoryReplay(initial, events)", () => new FactoryReplay(initial, events));
mean("full replay (step over all events)", () => {
  const r = new FactoryReplay(initial, events);
  while (!r.done) r.step();
});
const end = events[events.length - 1].timestamp;
mean("seek to 100% incl. reset", () => {
  const r = new FactoryReplay(initial, events);
  r.seekTo(end);
  r.seekTo(initial.state.asOf);
});
const cloneMs = mean("structuredClone(final state)", () => structuredClone(finalState));
mean("JSON.stringify(final state)", () => JSON.stringify(finalState));
console.log(`clone-per-event over the log (upper bound, final-size state): ~${((cloneMs * events.length) / 1000).toFixed(0)} s`);
