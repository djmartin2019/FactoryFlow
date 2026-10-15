/**
 * Loading the generated dataset into the (future) simulation engine.
 *   npm run generate:data && npm run example:replay
 *
 * In the Vite app the same data would be imported as JSON or fetched:
 *   const initial = await (await fetch("/data/generated/initial_state.json")).json();
 *   const events  = await (await fetch("/data/generated/events.json")).json();
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FactoryReplay } from "../src/manufacturing/replay.ts";
import { factoryObjectsForEvent } from "../src/manufacturing/mapping.ts";
import { inventoryByLocation, materialShortages, wipByLocation, workstationViews } from "../src/manufacturing/selectors.ts";
import type { FactoryEvent, InitialStateFile } from "../src/manufacturing/types.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "generated");
const load = <T>(name: string): T => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));

const initial = load<InitialStateFile>("initial_state");
const events = load<FactoryEvent[]>("events");
const replay = new FactoryReplay(initial, events);

// 1. Subscribe: this is where a Three.js layer would highlight meshes / spawn flow animations.
let shown = 0;
replay.onEvent((event) => {
  const { objectIds, flows } = factoryObjectsForEvent(event);
  if (event.type === "MACHINE_FAILED" || event.type === "SHIPMENT_DISPATCHED") {
    if (shown++ < 6) console.log(event.timestamp, event.type, "-> objects", objectIds, "flows", flows.length);
  }
});

// 2. Drive it with a simulated clock (here: one day per tick).
const DAY = 86_400_000;
let clock = Date.parse(initial.state.asOf);
const end = Date.parse(events[events.length - 1].timestamp);
for (let day = 1; clock < end; day++) {
  clock += DAY;
  replay.advanceTo(new Date(clock).toISOString());
  if (day % 10 === 0) {
    const s = replay.state;
    const busy = workstationViews(s, replay.master).map((w) => `${w.workstationId}:${w.objectStatus}`).join(" ");
    const wip = Object.values(wipByLocation(s)).reduce((n, w) => n + w.units, 0);
    console.log(`day ${day}: ${busy} | WIP units ${wip} | shortages ${materialShortages(s, replay.master).length}`);
  }
}

// 3. Dashboard-style queries on the final state.
const racks = inventoryByLocation(replay.state, replay.master)["INV-002"];
console.log("INV-002 holds", racks.items.length, "items,", Math.round(racks.utilization * 100) + "% pallets used");
