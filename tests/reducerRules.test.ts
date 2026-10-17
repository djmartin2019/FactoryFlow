/**
 * docs/REDUCER_RULES.md classifies every `req(...)` in the reducer. This keeps the table honest: a new, moved or
 * removed rule fails here until the document is updated.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RULE_CLASSES } from "../src/sources/index.ts";

const root = new URL("../", import.meta.url);
const stateLines = readFileSync(new URL("src/manufacturing/state.ts", root), "utf8").split("\n");
const doc = readFileSync(new URL("docs/REDUCER_RULES.md", root), "utf8");

const table = doc.slice(doc.indexOf("<!-- rules:start -->"), doc.indexOf("<!-- rules:end -->"));
const rows = table
  .split("\n")
  .filter((l) => l.startsWith("| ") && !l.startsWith("| Lines") && !l.startsWith("| ---"))
  .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));

function linesOf(cell: string): number[] {
  const out: number[] = [];
  for (const part of cell.replace(/\*/g, "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`bad line spec "${part}"`);
    const [a, b] = [Number(m[1]), Number(m[2] ?? m[1])];
    for (let n = a; n <= b; n++) out.push(n);
  }
  return out;
}

/** 1-based line numbers of every `req(` call, excluding the helper's own declaration. */
const reqLines = stateLines.flatMap((text, i) => (/\breq\(/.test(text) && !text.startsWith("function req(") ? [i + 1] : []));

describe("reducer rule classification", () => {
  it("has a row for every rule with a known class", () => {
    expect(rows.length).toBeGreaterThan(20);
    for (const r of rows) {
      expect(r).toHaveLength(5);
      expect(RULE_CLASSES as readonly string[], r[0]).toContain(r[2].replace(/`/g, ""));
    }
  });

  it("covers every req() in state.ts", () => {
    const covered = new Set(rows.flatMap((r) => linesOf(r[0])));
    expect(reqLines.filter((n) => !covered.has(n))).toEqual([]);
  });

  it("lists only lines that contain a rule, and no line twice", () => {
    const listed = rows.flatMap((r) => linesOf(r[0]));
    expect(new Set(listed).size).toBe(listed.length);
    const reqSet = new Set(reqLines);
    // Ranges (e.g. 383-391) may span non-rule lines; every other listed line must be a req() line.
    for (const r of rows) {
      const isRange = r[0].includes("-");
      for (const n of linesOf(r[0])) if (!isRange) expect(reqSet.has(n), `line ${n}: ${stateLines[n - 1]?.trim()}`).toBe(true);
    }
  });
});
