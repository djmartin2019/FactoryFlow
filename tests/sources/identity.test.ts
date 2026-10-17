import { describe, expect, it } from "vitest";
import { Rng } from "../../src/manufacturing/rng.ts";
import {
  DERIVED_PREFIX,
  ENTITY_TYPES,
  createIdentityIndex,
  deriveCanonicalId,
  derivedResolver,
  escapeSegment,
  findCollisions,
  isValidCanonicalId,
  parseDerivedId,
  passthroughResolver,
  sourceKeyString,
  unescapeSegment,
  type EntityType,
  type SourceKey,
} from "../../src/sources/index.ts";
import { dataset } from "../helpers/atomicity.ts";

const key = (sourceId: string, entityType: EntityType, k: string, scope?: SourceKey["scope"]): SourceKey => ({ sourceId, entityType, key: k, ...(scope ? { scope } : {}) });

/** Keys built from characters that break naive schemes: separators, escapes, colons, unicode, whitespace. */
function adversarialKeys(count: number, seed: string): SourceKey[] {
  const rng = new Rng(seed);
  const atoms = ["-", "_", ".", "::", ":", "_2D", "_5F", "_2E", "%", "/", " ", "A", "z", "0", "é", "日", "😀", "\n", "\u0000", "..", "--", "__", "-.", "._", "PO", "WO-1", "1042"];
  const sources = ["erp", "mes", "e-rp", "e_rp", "e.rp", "erp-mes", "erp.mes", "_", "-", "."];
  const scopes: (SourceKey["scope"] | undefined)[] = [undefined, {}, { tenantId: "t" }, { siteId: "s" }, { tenantId: "", siteId: "s" }, { tenantId: "t", siteId: "" }, { tenantId: "a-b", siteId: "c.d" }];
  const out: SourceKey[] = [];
  for (let i = 0; i < count; i++) {
    const len = rng.int(1, 6);
    const k = Array.from({ length: len }, () => rng.pick(atoms)).join("");
    out.push(key(rng.pick(sources), rng.pick(ENTITY_TYPES), k, rng.pick(scopes)));
  }
  return out;
}

describe("escaping", () => {
  it("keeps only [A-Za-z0-9_-] and is reversible for any text", () => {
    const rng = new Rng("escape");
    const alphabet = ["a", "Z", "9", "-", "_", ".", ":", "::", " ", "é", "日", "😀", "\u0000", "\uD800" /* lone surrogate */, "%", "/"];
    for (let i = 0; i < 500; i++) {
      const text = Array.from({ length: rng.int(0, 8) }, () => rng.pick(alphabet)).join("");
      const esc = escapeSegment(text);
      expect(esc, JSON.stringify(text)).toMatch(/^[A-Za-z0-9_-]*$/);
      // Lone surrogates are not valid UTF-8 text; they are replaced, everything else round-trips exactly.
      if (!text.includes("\uD800")) expect(unescapeSegment(esc)).toBe(text);
    }
  });

  it("rejects text that is not a valid escaped segment", () => {
    for (const bad of ["a.b", "a_", "a_G0", "_8", "a b", "::", "_FF" /* invalid utf-8 */]) expect(unescapeSegment(bad), bad).toBeNull();
  });
});

describe("derived ids", () => {
  it("are stable: the same key always yields the same id", () => {
    const k = key("erp", "productionOrder", "1042");
    expect(deriveCanonicalId(k)).toBe("WO.erp.1042");
    expect(deriveCanonicalId({ ...k })).toBe(deriveCanonicalId(k));
    expect(derivedResolver(k)).toEqual({ status: "resolved", canonicalId: "WO.erp.1042" });
  });

  it("are valid canonical ids and never contain '::' (adversarial keys)", () => {
    for (const k of adversarialKeys(2000, "valid")) {
      const id = deriveCanonicalId(k);
      expect(isValidCanonicalId(id), id).toBe(true);
      expect(id.includes("::"), id).toBe(false);
    }
  });

  it("are collision-free: distinct keys never share an id (adversarial keys)", () => {
    const keys = adversarialKeys(5000, "collide");
    expect(findCollisions(keys, derivedResolver)).toEqual([]);
    // sanity: the generator really produced many distinct keys
    expect(new Set(keys.map(sourceKeyString)).size).toBeGreaterThan(4000);
  });

  it("are reversible: parsing a derived id returns the key (absent scope stays absent)", () => {
    for (const k of adversarialKeys(2000, "reverse")) {
      const id = deriveCanonicalId(k);
      const parsed = parseDerivedId(id);
      expect(parsed, id).not.toBeNull();
      expect(sourceKeyString(parsed!), id).toBe(sourceKeyString(k));
    }
  });

  it("keep one source's '1042' apart from another's, and entity types apart", () => {
    const a = deriveCanonicalId(key("erp", "productionOrder", "1042"));
    const b = deriveCanonicalId(key("mes", "productionOrder", "1042"));
    const c = deriveCanonicalId(key("erp", "purchaseOrder", "1042"));
    const d = deriveCanonicalId(key("erp", "productionOrder", "1042", { siteId: "plant-2" }));
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it("distinguish tenant-only from site-only scope, and an empty tenant from none", () => {
    const base = key("erp", "shipment", "9");
    const ids = [
      deriveCanonicalId(base),
      deriveCanonicalId({ ...base, scope: { tenantId: "x" } }),
      deriveCanonicalId({ ...base, scope: { siteId: "x" } }),
      deriveCanonicalId({ ...base, scope: { tenantId: "x", siteId: "x" } }),
    ];
    expect(new Set(ids).size).toBe(4);
  });

  it("treat an empty tenant or site as none", () => {
    const base = key("erp", "shipment", "9");
    expect(deriveCanonicalId({ ...base, scope: { tenantId: "", siteId: "" } })).toBe(deriveCanonicalId(base));
    expect(deriveCanonicalId({ ...base, scope: { tenantId: "", siteId: "s" } })).toBe(deriveCanonicalId({ ...base, scope: { siteId: "s" } }));
    expect(sourceKeyString({ ...base, scope: { tenantId: "" } })).toBe(sourceKeyString(base));
  });

  it("use a distinct prefix per entity type", () => {
    expect(new Set(Object.values(DERIVED_PREFIX)).size).toBe(ENTITY_TYPES.length);
    for (const t of ENTITY_TYPES) expect(DERIVED_PREFIX[t]).toBeDefined();
  });

  it("leave empty keys and sources unresolved rather than inventing an id", () => {
    expect(derivedResolver(key("erp", "shipment", "")).status).toBe("unresolved");
    expect(derivedResolver(key("", "shipment", "1")).status).toBe("unresolved");
  });

  it("are not parsed from ids that are not derived", () => {
    for (const id of ["WO-0001", "WO.erp", "XX.erp.1", "WO.er p.1", "WO.erp.1.2.3.4"]) expect(parseDerivedId(id), id).toBeNull();
  });
});

describe("passthrough ids", () => {
  it("map every master-data id of the simulation to itself", () => {
    const m = dataset().master;
    const rows: [EntityType, string][] = [
      ...m.locations.map((x): [EntityType, string] => ["location", x.id]),
      ...m.workstations.map((x): [EntityType, string] => ["workstation", x.id]),
      ...m.materials.map((x): [EntityType, string] => ["material", x.id]),
      ...m.products.map((x): [EntityType, string] => ["product", x.id]),
      ...m.suppliers.map((x): [EntityType, string] => ["supplier", x.id]),
      ...m.customers.map((x): [EntityType, string] => ["customer", x.id]),
      ...Object.keys(dataset().finalState.productionOperations).map((id): [EntityType, string] => ["productionOperation", id]),
    ];
    expect(rows.length).toBeGreaterThan(1000);
    for (const [t, id] of rows) expect(passthroughResolver(key("sim", t, id)), id).toEqual({ status: "resolved", canonicalId: id });
  });

  it("refuse keys that are not valid canonical ids instead of rewriting them", () => {
    for (const bad of ["", "a::b", "a b", "a/b", "é", "a:b"]) expect(passthroughResolver(key("sim", "location", bad)).status, bad).toBe("unresolved");
  });
});

describe("identity index", () => {
  const erpWo = key("erp", "productionOrder", "1042");
  const mesWo = key("mes", "productionOrder", "WO-001042");

  it("lets a crosswalk entry win over derivation and join two systems on one canonical id", () => {
    const { resolve, issues } = createIdentityIndex({
      version: "v1",
      entries: [
        { key: erpWo, canonicalId: "WO-1042" },
        { key: mesWo, canonicalId: "WO-1042" },
      ],
    });
    expect(issues).toEqual([]);
    expect(resolve(erpWo)).toEqual({ status: "resolved", canonicalId: "WO-1042" });
    expect(resolve(mesWo)).toEqual({ status: "resolved", canonicalId: "WO-1042" });
    // Not in the map: derived, and different from the crosswalk id.
    expect(resolve(key("erp", "productionOrder", "2000"))).toEqual({ status: "resolved", canonicalId: "WO.erp.2000" });
  });

  it("reports a conflict when one key is mapped to several canonical ids (all rows fail closed)", () => {
    const { resolve, issues } = createIdentityIndex({
      version: "v1",
      entries: [
        { key: erpWo, canonicalId: "WO-A" },
        { key: erpWo, canonicalId: "WO-B" },
      ],
    });
    expect(resolve(erpWo)).toMatchObject({ status: "conflict", candidates: ["WO-A", "WO-B"] });
    expect(issues.some((i) => i.code === "IDENTITY_CONFLICT")).toBe(true);
  });

  it("reports a conflict when two keys of one source and type share an id without declared aliasing", () => {
    const other = key("erp", "productionOrder", "1043");
    const { resolve } = createIdentityIndex({ version: "v1", entries: [{ key: erpWo, canonicalId: "WO-X" }, { key: other, canonicalId: "WO-X" }] });
    expect(resolve(erpWo).status).toBe("conflict");
    expect(resolve(other).status).toBe("conflict");
  });

  it("allows same-source aliases when every row declares it", () => {
    const other = key("erp", "productionOrder", "1043");
    const { resolve, issues } = createIdentityIndex({
      version: "v1",
      entries: [
        { key: erpWo, canonicalId: "WO-X", declaredAlias: true },
        { key: other, canonicalId: "WO-X", declaredAlias: true },
      ],
    });
    expect(issues).toEqual([]);
    expect(resolve(other)).toEqual({ status: "resolved", canonicalId: "WO-X" });
  });

  it("flags an invalid crosswalk id and leaves that key unresolved", () => {
    const { resolve, issues } = createIdentityIndex({ version: "v1", entries: [{ key: erpWo, canonicalId: "WO::1" }] });
    expect(issues[0]).toMatchObject({ severity: "error", code: "INVALID_CANONICAL_ID" });
    expect(resolve(erpWo).status).toBe("unresolved");
  });

  it("flags a generated id that lands on a crosswalk id owned by another key", () => {
    // WO.erp.2000 is what derivation gives for erp/2000; the crosswalk hands the same id to a different key.
    const { resolve } = createIdentityIndex({ version: "v1", entries: [{ key: mesWo, canonicalId: "WO.erp.2000" }] });
    expect(resolve(key("erp", "productionOrder", "2000"))).toMatchObject({ status: "conflict", candidates: ["WO.erp.2000"] });
    expect(resolve(mesWo)).toEqual({ status: "resolved", canonicalId: "WO.erp.2000" });
  });

  it("applies passthrough to listed sources, derives for others, and can refuse to derive", () => {
    const idx = createIdentityIndex({ version: "v1", entries: [] }, { passthroughSources: ["sim"] });
    expect(idx.resolve(key("sim", "location", "ASM-001"))).toEqual({ status: "resolved", canonicalId: "ASM-001" });
    expect(idx.resolve(key("erp", "location", "ASM-001"))).toEqual({ status: "resolved", canonicalId: "LOC.erp.ASM-001" });
    const strict = createIdentityIndex({ version: "v1", entries: [] }, { deriveUnmapped: false });
    expect(strict.resolve(erpWo)).toMatchObject({ status: "unresolved" });
  });

  it("is deterministic: entry order in the map does not change any resolution", () => {
    const rng = new Rng("map-order");
    const entries = Array.from({ length: 30 }, (_, i) => ({ key: key(i % 2 ? "erp" : "mes", "material", `M${i}`), canonicalId: `MAT-${i % 20}` }));
    const keys = entries.map((e) => e.key);
    const reference = createIdentityIndex({ version: "v", entries });
    for (let round = 0; round < 20; round++) {
      const shuffled = [...entries].sort(() => rng.next() - 0.5);
      const idx = createIdentityIndex({ version: "v", entries: shuffled });
      for (const k of keys) expect(idx.resolve(k)).toEqual(reference.resolve(k));
    }
  });
});
