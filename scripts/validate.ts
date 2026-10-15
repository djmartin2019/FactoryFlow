/**
 * Validate data/generated against its own replay source and regenerate from the
 * manifest seed to prove determinism.   npm run validate:data
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateDataset } from "../src/manufacturing/generator.ts";
import { validateDataset } from "../src/manufacturing/validation.ts";
import type { FactoryEvent, FactoryState, InitialStateFile, Manifest, ManufacturingDataset } from "../src/manufacturing/types.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "generated");
const read = <T>(name: string): T => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));

const manifest = read<Manifest>("manifest");
const initial = read<InitialStateFile>("initial_state");
const dataset: ManufacturingDataset = {
  manifest,
  master: initial.master,
  initialState: initial.state,
  events: read<FactoryEvent[]>("events"),
  finalState: read<FactoryState>("final_state"),
};

let failed = false;
const report = validateDataset(dataset);
for (const c of report.checks) {
  console.log(`${c.problems.length === 0 ? "PASS" : "FAIL"}  ${c.name}`);
  for (const p of c.problems) console.log(`        - ${p}`);
}
failed ||= !report.ok;

if (dataset.events.length !== manifest.eventCount) {
  console.log(`FAIL  manifest eventCount ${manifest.eventCount} != ${dataset.events.length}`);
  failed = true;
}

const regenerated = generateDataset(manifest.config);
const same = regenerated.manifest.eventLogHash === manifest.eventLogHash;
console.log(`${same ? "PASS" : "FAIL"}  regenerating from manifest seed reproduces the event log (${manifest.eventLogHash})`);
failed ||= !same;

console.log(failed ? "\nVALIDATION FAILED" : `\nAll ${report.checks.length + 2} checks passed (${manifest.eventCount} events).`);
process.exit(failed ? 1 : 0);
