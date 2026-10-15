/**
 * Generate the synthetic Northstar Components dataset.
 *   npm run generate:data -- --seed=my-seed --days=30 --customerOrders=75
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateDataset } from "../src/manufacturing/generator.ts";
import { buildTables } from "../src/manufacturing/tables.ts";
import { validateDataset } from "../src/manufacturing/validation.ts";
import type { GeneratorConfig } from "../src/manufacturing/types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "data", "generated");

const overrides: Partial<GeneratorConfig> = {};
const numeric = ["days", "customerOrders", "purchaseOrders", "customerCount", "assemblyWorkstations", "inspectionWorkstations", "openingFinishedGoodsUnits", "minProductionLot", "machineFailuresPerWorkstation"] as const;
for (const arg of process.argv.slice(2)) {
  const [key, value] = arg.replace(/^--/, "").split("=");
  if (key === "seed") overrides.seed = value;
  else if (key === "startDate") overrides.startDate = value;
  else if ((numeric as readonly string[]).includes(key)) (overrides as any)[key] = Number(value);
  else if (key === "noSurge") overrides.demandSurge = null;
  else throw new Error(`Unknown option --${key}`);
}

const dataset = generateDataset(overrides);
const report = validateDataset(dataset);
if (!report.ok) {
  console.error("Generated dataset failed validation:");
  for (const c of report.checks) for (const p of c.problems) console.error(`  [${c.name}] ${p}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
for (const [name, content] of Object.entries(buildTables(dataset))) {
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(content, null, name === "events" || name === "inventory_transactions" ? 0 : 2) + "\n");
}
const m = dataset.manifest;
console.log(`Wrote ${Object.keys(buildTables(dataset)).length} files to ${outDir}`);
console.log(`seed=${m.seed} events=${m.eventCount} range=${m.simulatedRange.start} .. ${m.simulatedRange.end} hash=${m.eventLogHash}`);
console.log(m.recordCounts);
