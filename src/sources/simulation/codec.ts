/**
 * Table-driven wire codec (M2 of docs/SOURCE_INTEGRATION_PLAN_REV3.md, section 7.11).
 *
 * An entity is described once, as data: its domain fields with a short type string. The wire name of a field is derived
 * (snake_case, `quantity` becomes `qty`, minutes become seconds `_s`), values are converted by kind (timestamps lose
 * their `.000`, minutes become seconds, status enums become short codes), and decoding validates and reports
 * `MappingIssue`s instead of throwing.
 *
 * Shorthand: `id` `str` `int` `num` `bool` `ts` `min` `qty` (an int named `qty` on the wire), `enum:Name`, `@Entity`,
 * `inventory` (balances as rows), with modifiers `[]` (array), `{}` (record keyed by id) and `?` (optional), in that order.
 *
 * Decoding walks the wire object in its own key order, so the decoded object has exactly the key order the domain
 * object had when it was emitted (this keeps JSON-based hashes of the log stable).
 */
import { normalizeTimestamp } from "../canonicalJson.ts";
import { isValidCanonicalId } from "../identity.ts";
import type { MappingIssue } from "../types.ts";
import { inventoryKey } from "../../manufacturing/state.ts";
import type { InventoryBalance } from "../../manufacturing/types.ts";

type Prim = "id" | "str" | "int" | "num" | "bool";
type Kind =
  | { t: "prim"; p: Prim }
  | { t: "ts" }
  | { t: "min" }
  | { t: "enum"; name: string }
  | { t: "ref"; entity: string }
  | { t: "inventory" }
  | { t: "arr"; of: Kind }
  | { t: "rec"; of: Kind };

interface Field {
  domain: string;
  wire: string;
  kind: Kind;
  optional: boolean;
}

interface CompiledEntity {
  name: string;
  fields: Field[];
  byDomain: Map<string, Field>;
  byWire: Map<string, Field>;
}

export type EntitySpec<T> = { [K in keyof Required<T>]: string };
export type EnumCodes = Record<string, Record<string, string>>;

const PRIMS: ReadonlySet<string> = new Set(["id", "str", "int", "num", "bool", "qty"]);

function parseKind(text: string, where: string): Kind {
  if (text.endsWith("[]")) return { t: "arr", of: parseKind(text.slice(0, -2), where) };
  if (text.endsWith("{}")) return { t: "rec", of: parseKind(text.slice(0, -2), where) };
  if (text === "ts") return { t: "ts" };
  if (text === "min") return { t: "min" };
  if (text === "inventory") return { t: "inventory" };
  if (text.startsWith("enum:")) return { t: "enum", name: text.slice(5) };
  if (text.startsWith("@")) return { t: "ref", entity: text.slice(1) };
  if (PRIMS.has(text)) return { t: "prim", p: text === "qty" ? "int" : (text as Prim) };
  throw new Error(`wire spec ${where}: unknown type "${text}"`);
}

/** snake_case, `quantity` -> `qty`; for minutes fields the `minutes` token becomes `s` (the wire carries seconds). */
export function wireNameOf(domain: string, kind: Kind): string {
  const tokens = domain.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split("_");
  const isMinutes = (k: Kind): boolean => (k.t === "min" ? true : k.t === "arr" || k.t === "rec" ? isMinutes(k.of) : false);
  const minutes = isMinutes(kind);
  return tokens.map((t) => (t === "quantity" ? "qty" : minutes && t === "minutes" ? "s" : t)).join("_");
}

/** Wire timestamp: UTC with an explicit `Z`, no fractional part when the millisecond is zero. */
export function toWireTimestamp(domainTimestamp: string): string {
  return domainTimestamp.endsWith(".000Z") ? `${domainTimestamp.slice(0, -5)}Z` : domainTimestamp;
}

export interface Codec {
  encode(entity: string, value: unknown): unknown;
  decode(entity: string, wire: unknown, path?: string): { ok: true; value: unknown } | { ok: false; issues: MappingIssue[] };
  /** Wire key of a domain field (for tests and diagnostics). */
  wireName(entity: string, domainField: string): string;
  entities(): string[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

export function createCodec(specs: Record<string, Record<string, string>>, enums: EnumCodes): Codec {
  const compiled = new Map<string, CompiledEntity>();
  for (const [name, spec] of Object.entries(specs)) {
    const fields: Field[] = [];
    const byDomain = new Map<string, Field>();
    const byWire = new Map<string, Field>();
    for (const [domain, text] of Object.entries(spec)) {
      const optional = text.endsWith("?");
      const kind = parseKind(optional ? text.slice(0, -1) : text, `${name}.${domain}`);
      const field: Field = { domain, wire: wireNameOf(domain, kind), kind, optional };
      if (byWire.has(field.wire)) throw new Error(`wire spec ${name}: ${domain} and ${byWire.get(field.wire)!.domain} both map to "${field.wire}"`);
      fields.push(field);
      byDomain.set(domain, field);
      byWire.set(field.wire, field);
    }
    compiled.set(name, { name, fields, byDomain, byWire });
  }

  const reverseEnums = new Map<string, Map<string, string>>();
  for (const [name, codes] of Object.entries(enums)) {
    const rev = new Map<string, string>();
    for (const [domain, wire] of Object.entries(codes)) {
      if (rev.has(wire)) throw new Error(`enum ${name}: code "${wire}" is used twice`);
      rev.set(wire, domain);
    }
    reverseEnums.set(name, rev);
  }
  for (const e of compiled.values()) {
    for (const f of e.fields) checkRefs(f.kind, `${e.name}.${f.domain}`);
  }
  function checkRefs(k: Kind, where: string): void {
    if (k.t === "ref" && !compiled.has(k.entity)) throw new Error(`wire spec ${where}: unknown entity @${k.entity}`);
    if (k.t === "enum" && !enums[k.name]) throw new Error(`wire spec ${where}: unknown enum ${k.name}`);
    if (k.t === "arr" || k.t === "rec") checkRefs(k.of, where);
  }

  function entityOf(name: string): CompiledEntity {
    const e = compiled.get(name);
    if (!e) throw new Error(`no wire spec for ${name}`);
    return e;
  }

  // ----- encode (trusted domain data: a gap in the spec is a bug, so it throws) -----------------------------------

  function encodeValue(k: Kind, v: unknown, where: string): unknown {
    switch (k.t) {
      case "prim":
        return v;
      case "ts":
        return toWireTimestamp(v as string);
      case "min":
        return (v as number) * 60;
      case "enum": {
        const code = enums[k.name][v as string];
        if (code === undefined) throw new Error(`no wire code for ${k.name}.${String(v)} (${where})`);
        return code;
      }
      case "ref":
        return encodeEntity(entityOf(k.entity), v as Record<string, unknown>);
      case "inventory":
        return Object.values(v as Record<string, InventoryBalance>).map((b) => encodeEntity(entityOf("InventoryBalance"), b as never));
      case "arr":
        return (v as unknown[]).map((x, i) => encodeValue(k.of, x, `${where}.${i}`));
      case "rec": {
        const out: Record<string, unknown> = {};
        for (const [key, x] of Object.entries(v as Record<string, unknown>)) out[key] = encodeValue(k.of, x, `${where}.${key}`);
        return out;
      }
    }
  }

  function encodeEntity(e: CompiledEntity, obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      const f = e.byDomain.get(key);
      if (!f) throw new Error(`no wire mapping for ${e.name}.${key}`);
      out[f.wire] = encodeValue(f.kind, v, `${e.name}.${key}`);
    }
    return out;
  }

  // ----- decode (untrusted wire data: collect issues, never throw) -------------------------------------------------

  function decodeValue(k: Kind, v: unknown, path: string, issues: MappingIssue[], ctxFieldName: string): unknown {
    const bad = (code: string, message: string): undefined => {
      issues.push({ severity: "error", code, path, message });
      return undefined;
    };
    switch (k.t) {
      case "prim":
        switch (k.p) {
          case "id":
            if (typeof v !== "string") return bad("WRONG_TYPE", `${ctxFieldName} must be a string id`);
            if (!isValidCanonicalId(v)) return bad("INVALID_VALUE", `"${v}" is not a valid canonical id (passthrough namespace)`);
            return v;
          case "str":
            return typeof v === "string" ? v : bad("WRONG_TYPE", `${ctxFieldName} must be a string`);
          case "int":
            return typeof v === "number" && Number.isInteger(v) ? v : bad("WRONG_TYPE", `${ctxFieldName} must be an integer`);
          case "num":
            return typeof v === "number" && Number.isFinite(v) ? v : bad("WRONG_TYPE", `${ctxFieldName} must be a finite number`);
          case "bool":
            return typeof v === "boolean" ? v : bad("WRONG_TYPE", `${ctxFieldName} must be a boolean`);
        }
        break;
      case "ts": {
        if (typeof v !== "string") return bad("WRONG_TYPE", `${ctxFieldName} must be a timestamp string`);
        const n = normalizeTimestamp(v);
        return n ?? bad("BAD_TIMESTAMP", `"${v}" is not an ISO 8601 instant with an explicit zone (Z or +hh:mm)`);
      }
      case "min": {
        if (typeof v !== "number") return bad("WRONG_TYPE", `${ctxFieldName} must be a number of seconds`);
        if (!Number.isInteger(v) || v < 0) return bad("BAD_UNIT", `${v} is not a non-negative whole number of seconds`);
        if (v % 60 !== 0) return bad("BAD_UNIT", `${v} s is not a whole number of minutes (domain durations are integer minutes)`);
        return v / 60;
      }
      case "enum": {
        if (typeof v !== "string") return bad("WRONG_TYPE", `${ctxFieldName} must be a status code string`);
        const d = reverseEnums.get(k.name)!.get(v);
        return d ?? bad("UNKNOWN_CODE", `unknown ${k.name} code "${v}" (expected one of ${[...reverseEnums.get(k.name)!.keys()].join(", ")})`);
      }
      case "ref":
        return decodeEntity(entityOf(k.entity), v, path, issues);
      case "inventory": {
        if (!Array.isArray(v)) return bad("WRONG_TYPE", `${ctxFieldName} must be an array of stock rows`);
        const out: Record<string, InventoryBalance> = {};
        v.forEach((row, i) => {
          const b = decodeEntity(entityOf("InventoryBalance"), row, `${path}.${i}`, issues) as InventoryBalance | undefined;
          if (!b) return;
          const key = inventoryKey(b.locationId, b.itemId);
          if (Object.hasOwn(out, key)) issues.push({ severity: "error", code: "DUPLICATE_KEY", path: `${path}.${i}`, message: `stock row for ${key} appears twice` });
          else out[key] = b;
        });
        return out;
      }
      case "arr": {
        if (!Array.isArray(v)) return bad("WRONG_TYPE", `${ctxFieldName} must be an array`);
        return v.map((x, i) => decodeValue(k.of, x, `${path}.${i}`, issues, ctxFieldName));
      }
      case "rec": {
        if (!isPlainObject(v)) return bad("WRONG_TYPE", `${ctxFieldName} must be an object`);
        const out: Record<string, unknown> = {};
        for (const [key, x] of Object.entries(v)) out[key] = decodeValue(k.of, x, `${path}.${key}`, issues, ctxFieldName);
        return out;
      }
    }
  }

  function decodeEntity(e: CompiledEntity, wire: unknown, path: string, issues: MappingIssue[]): Record<string, unknown> | undefined {
    if (!isPlainObject(wire)) {
      issues.push({ severity: "error", code: "WRONG_TYPE", path: path || undefined, message: `${e.name} must be an object` });
      return undefined;
    }
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(wire)) {
      const f = e.byWire.get(key);
      const at = path ? `${path}.${key}` : key;
      if (!f) {
        issues.push({ severity: "error", code: "UNKNOWN_FIELD", path: at, message: `unexpected field "${key}" in ${e.name}` });
        continue;
      }
      if (v === undefined) continue;
      out[f.domain] = decodeValue(f.kind, v, at, issues, key);
    }
    for (const f of e.fields) {
      if (!f.optional && wire[f.wire] === undefined) {
        issues.push({ severity: "error", code: "MISSING_FIELD", path: path ? `${path}.${f.wire}` : f.wire, message: `${e.name} requires "${f.wire}"` });
      }
    }
    return out;
  }

  return {
    encode: (entity, value) => encodeEntity(entityOf(entity), value as Record<string, unknown>),
    decode(entity, wire, path = "") {
      const issues: MappingIssue[] = [];
      const value = decodeEntity(entityOf(entity), wire, path, issues);
      return issues.length === 0 && value !== undefined ? { ok: true, value } : { ok: false, issues };
    },
    wireName(entity, domainField) {
      const f = entityOf(entity).byDomain.get(domainField);
      if (!f) throw new Error(`no field ${entity}.${domainField}`);
      return f.wire;
    },
    entities: () => [...compiled.keys()],
  };
}
