import { describe, expect, it } from "vitest";
import * as z from "zod/mini";
import { codeMap, durationSeconds, fail, isoTimestamp, knownOf, nonEmptyString, nonNegativeInt, strictObject, validate } from "../../src/sources/index.ts";

/** A wire-shaped record exercising every primitive. */
const Wire = strictObject({
  event_id: nonEmptyString,
  occurred_at: isoTimestamp,
  qty: nonNegativeInt,
  setup_s: durationSeconds,
  status: codeMap({ RUN: "RUNNING", IDLE: "IDLE", DOWN: "DOWN" }),
});

const good = { event_id: "E-1", occurred_at: "2026-09-01T10:00:00+02:00", qty: 3, setup_s: 600, status: "RUN" };

describe("validate", () => {
  it("accepts a good record and normalizes timestamp, unit and status", () => {
    const r = validate(Wire, good);
    expect(r).toEqual({
      ok: true,
      value: { event_id: "E-1", occurred_at: "2026-09-01T08:00:00.000Z", qty: 3, setup_s: 10, status: "RUNNING" },
    });
  });

  it("reports a missing field with its path", () => {
    const { event_id: _drop, ...rest } = good;
    const r = validate(Wire, rest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues).toEqual([expect.objectContaining({ severity: "error", code: "MISSING_FIELD", path: "event_id" })]);
  });

  it("reports a wrong type", () => {
    const r = validate(Wire, { ...good, qty: "3" });
    expect(!r.ok && r.issues[0]).toMatchObject({ code: "WRONG_TYPE", path: "qty" });
  });

  it("reports a wrong unit instead of rounding (seconds that are not whole minutes, minutes passed as fractions)", () => {
    for (const setup_s of [90, 0.5, -60, 1e-9]) {
      const r = validate(Wire, { ...good, setup_s });
      expect(!r.ok && r.issues[0], String(setup_s)).toMatchObject({ code: "BAD_UNIT", path: "setup_s" });
    }
  });

  it("reports an unknown status code instead of defaulting", () => {
    const r = validate(Wire, { ...good, status: "MAINT" });
    expect(!r.ok && r.issues[0]).toMatchObject({ code: "UNKNOWN_CODE", path: "status" });
    expect(!r.ok && r.issues[0].message).toContain("MAINT");
  });

  it("reports bad timestamps: no zone, impossible date, 24:00, garbage, wrong type", () => {
    for (const occurred_at of ["2026-09-01T10:00:00", "2026-02-31T10:00:00Z", "2026-09-01T24:00:00Z", "2026-13-01T00:00:00Z", "yesterday", "2026-09-01T10:00:00+25:00"]) {
      const r = validate(Wire, { ...good, occurred_at });
      expect(!r.ok && r.issues[0], occurred_at).toMatchObject({ code: "BAD_TIMESTAMP", path: "occurred_at" });
    }
    const wrong = validate(Wire, { ...good, occurred_at: 1788249600000 });
    expect(!wrong.ok && wrong.issues[0].code).toBe("WRONG_TYPE");
  });

  it("reports unexpected fields from a strict object", () => {
    const r = validate(Wire, { ...good, qty_uom: "EA" });
    expect(!r.ok && r.issues[0]).toMatchObject({ code: "UNKNOWN_FIELD" });
  });

  it("collects several problems at once, attached to the source ref", () => {
    const ref = { sourceId: "sim", sourceEventId: "E-1" };
    const r = validate(Wire, { event_id: "", occurred_at: "nope", qty: -1, setup_s: 7, status: "?" }, ref);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.map((i) => i.path).sort()).toEqual(["event_id", "occurred_at", "qty", "setup_s", "status"]);
      expect(r.issues.every((i) => i.sourceRef === ref)).toBe(true);
    }
  });

  it("never throws, whatever the input", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const raw of [undefined, null, 0, "", [], [[]], {}, cyclic, Symbol("x"), () => 1, 10n, NaN, new Date(), { qty: Infinity }]) {
      expect(() => validate(Wire, raw), String(typeof raw)).not.toThrow();
      expect(validate(Wire, raw).ok).toBe(false);
    }
  });

  it("converts a throwing transform into an issue", () => {
    const boom = z.pipe(
      z.string(),
      z.transform(() => {
        throw new Error("adapter bug");
      }),
    );
    const r = validate(boom, "x");
    expect(!r.ok && r.issues[0]).toMatchObject({ code: "INTERNAL_ERROR", message: "adapter bug" });
  });

  it("lets a schema raise a coded issue", () => {
    const even = z.pipe(
      z.number(),
      z.transform((n, ctx) => (n % 2 !== 0 ? fail(ctx, "OUT_OF_RANGE", "must be even") : n)),
    );
    const r = validate(even, 3);
    expect(!r.ok && r.issues[0]).toMatchObject({ code: "OUT_OF_RANGE", message: "must be even" });
  });
});

describe("knownOf", () => {
  const field = knownOf(nonNegativeInt);
  it("keeps known, unknown and unsupported distinct and never coerces them", () => {
    expect(validate(field, { state: "known", value: 0 })).toEqual({ ok: true, value: { state: "known", value: 0 } });
    expect(validate(field, { state: "unknown" })).toEqual({ ok: true, value: { state: "unknown" } });
    expect(validate(field, { state: "unsupported" })).toEqual({ ok: true, value: { state: "unsupported" } });
  });

  it("validates the inner value and rejects a bare value", () => {
    expect(validate(field, { state: "known", value: -1 }).ok).toBe(false);
    expect(validate(field, { state: "known" }).ok).toBe(false);
    expect(validate(field, 0).ok).toBe(false);
    expect(validate(field, null).ok).toBe(false);
  });
});
