import { describe, expect, it } from "vitest";
import { Rng } from "../../src/manufacturing/rng.ts";
import { canonicalEqual, canonicalJson, contentDigest, contentKeyOf, normalizeTimestamp, parseIsoInstant } from "../../src/sources/index.ts";

describe("canonical JSON", () => {
  it("is invariant under key order, at every depth", () => {
    const a = { b: 1, a: { y: [1, { q: 1, p: 2 }], x: null }, c: "z" };
    const b = { c: "z", a: { x: null, y: [1, { p: 2, q: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"x":null,"y":[1,{"p":2,"q":1}]},"b":1,"c":"z"}');
  });

  it("is invariant under random key permutations (seeded)", () => {
    const rng = new Rng("canonical-json");
    const base: Record<string, unknown> = {};
    for (let i = 0; i < 12; i++) base[`k${i}`] = { n: i, t: "2026-09-01T10:00:00Z", list: [i, `s${i}`] };
    const expected = canonicalJson(base);
    for (let round = 0; round < 50; round++) {
      const keys = Object.keys(base).sort(() => rng.next() - 0.5);
      expect(canonicalJson(Object.fromEntries(keys.map((k) => [k, base[k]])))).toBe(expected);
    }
  });

  it("is invariant under timestamp spelling", () => {
    const spellings = [
      "2026-09-01T08:00:00Z",
      "2026-09-01T08:00:00.000Z",
      "2026-09-01T08:00:00.0000000Z",
      "2026-09-01T10:00:00+02:00",
      "2026-09-01T03:30:00-04:30",
      "2026-09-01T08:00:00.000+00:00",
    ];
    const canon = spellings.map((t) => canonicalJson({ at: t, nested: [{ at: t }] }));
    expect(new Set(canon).size).toBe(1);
    expect(canon[0]).toContain("2026-09-01T08:00:00.000Z");
  });

  it("keeps different instants different, and truncates sub-millisecond digits", () => {
    expect(canonicalEqual({ at: "2026-09-01T08:00:00.001Z" }, { at: "2026-09-01T08:00:00.000Z" })).toBe(false);
    expect(normalizeTimestamp("2026-09-01T08:00:00.0019Z")).toBe("2026-09-01T08:00:00.001Z");
  });

  it("leaves strings that are not explicit-zone instants untouched", () => {
    for (const s of ["2026-09-01T08:00:00", "2026-09-01", "WO-1042", "2026-02-31T00:00:00Z"]) {
      expect(canonicalJson(s)).toBe(JSON.stringify(s));
    }
  });

  it("normalizes numbers: -0 is 0, 1.0 is 1, non-finite throws", () => {
    expect(canonicalJson([-0, 1.0, 1e21, 0.1])).toBe("[0,1,1e+21,0.1]");
    for (const bad of [NaN, Infinity, -Infinity]) expect(() => canonicalJson({ n: bad })).toThrow(TypeError);
  });

  it("omits undefined properties, nulls undefined array items, rejects unsupported values", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalEqual({ a: undefined }, {})).toBe(true);
    expect(canonicalJson([undefined])).toBe("[null]");
    expect(() => canonicalJson({ d: new Date() })).toThrow(TypeError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
    expect(() => canonicalJson(10n)).toThrow(TypeError);
  });

  it("distinguishes array order, null from missing, and zero from unknown", () => {
    expect(canonicalEqual([1, 2], [2, 1])).toBe(false);
    expect(canonicalEqual({ a: null }, {})).toBe(false);
    expect(canonicalEqual({ qty: { state: "known", value: 0 } }, { qty: { state: "unknown" } })).toBe(false);
  });
});

describe("timestamps", () => {
  it("rejects impossible instants that Date.parse would roll over", () => {
    for (const t of ["2026-02-31T00:00:00Z", "2026-04-31T00:00:00Z", "2026-09-01T24:00:00Z", "2026-09-01T00:60:00Z", "2026-00-10T00:00:00Z", "2026-09-01T00:00:00+24:00"]) {
      expect(parseIsoInstant(t), t).toBeNull();
    }
    expect(parseIsoInstant("2028-02-29T00:00:00Z")).not.toBeNull();
    expect(parseIsoInstant("2027-02-29T00:00:00Z")).toBeNull();
  });

  it("agrees with Date.parse on valid explicit-zone instants", () => {
    for (const t of ["2026-09-01T08:00:00Z", "2026-12-31T23:59:59.999Z", "2026-09-01T10:00:00+02:00", "1999-01-01T00:00:00-05:00"]) {
      expect(parseIsoInstant(t), t).toBe(Date.parse(t));
    }
  });
});

describe("content digest", () => {
  it("is stable, 16 hex digits, and differs for different content", () => {
    expect(contentDigest("abc")).toBe(contentDigest("abc"));
    expect(contentDigest("abc")).toMatch(/^[0-9a-f]{16}$/);
    expect(contentDigest("abc")).not.toBe(contentDigest("abd"));
    expect(contentDigest("")).toBe("cbf29ce484222325"); // FNV-1a 64 offset basis
  });

  it("content keys ignore key order and timestamp spelling", () => {
    expect(contentKeyOf({ a: 1, t: "2026-09-01T08:00:00Z" })).toBe(contentKeyOf({ t: "2026-09-01T10:00:00+02:00", a: 1 }));
  });
});
