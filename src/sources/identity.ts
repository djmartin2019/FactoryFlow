/**
 * Identity policy (plan 7.3): source keys to canonical ids, deterministically, with conflicts reported not guessed.
 *
 * Canonical ids are opaque strings over `[A-Za-z0-9._-]` and never contain `::` (`inventoryKey` joins
 * `locationId::itemId`). Three ways to get one:
 *  - passthrough: `canonicalId = key`, for the simulation namespace (keeps hashes and scene-object ids);
 *  - derived composite: `PREFIX.<source>.<key>[.<tenant>[.<site>]]` with reversible escaping;
 *  - an explicit crosswalk entry, which always wins over derivation.
 * No fuzzy matching and no auto-merge.
 */
import type {
  EntityType,
  IdentityMap,
  IdentityMapEntry,
  IdentityResolution,
  IdentityResolver,
  MappingIssue,
  SourceKey,
} from "./types.ts";
import { ENTITY_TYPES } from "./types.ts";

const CANONICAL_ID = /^[A-Za-z0-9._-]+$/;

export function isValidCanonicalId(id: string): boolean {
  return CANONICAL_ID.test(id) && !id.includes("::");
}

/** An empty tenant or site means "none": `{ tenantId: "" }`, `{}` and no scope are the same key. */
function scopeParts(k: SourceKey): { tenantId?: string; siteId?: string } {
  return { tenantId: k.scope?.tenantId || undefined, siteId: k.scope?.siteId || undefined };
}

/** Stable text form of a key: equality over every field, empty scope parts equal to absent ones. */
export function sourceKeyString(k: SourceKey): string {
  const { tenantId, siteId } = scopeParts(k);
  return JSON.stringify([k.sourceId, k.entityType, k.key, tenantId ?? null, siteId ?? null]);
}

// ---------------------------------------------------------------------------
// Reversible escaping
// ---------------------------------------------------------------------------

const SAFE = /[A-Za-z0-9-]/;

/**
 * Keep `[A-Za-z0-9-]`, encode every other UTF-8 byte (including `_` and `.`) as `_HH`. The output never contains
 * `.`, `:` or anything outside `[A-Za-z0-9_-]`, so `.` can separate segments unambiguously.
 */
export function escapeSegment(text: string): string {
  let out = "";
  for (const ch of text) {
    if (SAFE.test(ch)) out += ch;
    else for (const byte of new TextEncoder().encode(ch)) out += `_${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** Inverse of `escapeSegment`; `null` when `text` is not a valid escaped segment. */
export function unescapeSegment(text: string): string | null {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "_") {
      const hex = text.slice(i + 1, i + 3);
      if (!/^[0-9A-F]{2}$/.test(hex)) return null;
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else if (SAFE.test(ch)) {
      bytes.push(ch.charCodeAt(0));
    } else {
      return null;
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Passthrough and derived resolvers
// ---------------------------------------------------------------------------

/** Canonical id prefix per entity type for derived ids. */
export const DERIVED_PREFIX: Record<EntityType, string> = {
  supplier: "SUP",
  customer: "CUS",
  product: "PRD",
  material: "MAT",
  location: "LOC",
  workstation: "WST",
  equipment: "EQP",
  purchaseOrder: "PO",
  receipt: "RCV",
  inventoryTransfer: "TRF",
  customerOrder: "CO",
  productionOrder: "WO",
  productionOperation: "OP",
  workstationAssignment: "ASG",
  qualityInspection: "QI",
  shipment: "SHP",
  downtime: "DT",
};

/** `canonicalId = key`, provided the key is already a valid canonical id. */
export const passthroughResolver: IdentityResolver = (key) => {
  if (key.key === "") return { status: "unresolved", reason: "empty key" };
  if (!isValidCanonicalId(key.key)) {
    return { status: "unresolved", reason: `key "${key.key}" is not a valid canonical id (allowed [A-Za-z0-9._-], no "::")` };
  }
  return { status: "resolved", canonicalId: key.key };
};

/** Derived composite id: `PREFIX.source.key`, plus tenant and site segments when a scope is present. */
export function deriveCanonicalId(key: SourceKey): string {
  const parts = [DERIVED_PREFIX[key.entityType], escapeSegment(key.sourceId), escapeSegment(key.key)];
  const { tenantId, siteId } = scopeParts(key);
  if (tenantId !== undefined || siteId !== undefined) parts.push(escapeSegment(tenantId ?? ""));
  if (siteId !== undefined) parts.push(escapeSegment(siteId));
  return parts.join(".");
}

/** Inverse of `deriveCanonicalId`, or `null` when `id` is not a derived id. Absent (or empty) scope parts stay absent. */
export function parseDerivedId(id: string): SourceKey | null {
  const parts = id.split(".");
  if (parts.length < 3 || parts.length > 5) return null;
  const entityType = ENTITY_TYPES.find((t) => DERIVED_PREFIX[t] === parts[0]);
  if (!entityType) return null;
  const decoded = parts.slice(1).map(unescapeSegment);
  if (decoded.some((d) => d === null)) return null;
  const [sourceId, key, tenantId, siteId] = decoded as string[];
  const scope: { tenantId?: string; siteId?: string } = {};
  if (tenantId) scope.tenantId = tenantId;
  if (siteId) scope.siteId = siteId;
  return { sourceId, entityType, key, ...(Object.keys(scope).length > 0 ? { scope } : {}) };
}

export const derivedResolver: IdentityResolver = (key) => {
  if (key.sourceId === "") return { status: "unresolved", reason: "empty sourceId" };
  if (key.key === "") return { status: "unresolved", reason: "empty key" };
  return { status: "resolved", canonicalId: deriveCanonicalId(key) };
};

// ---------------------------------------------------------------------------
// Identity map (crosswalk) and the composed resolver
// ---------------------------------------------------------------------------

export interface IdentityIndex {
  /** Crosswalk first, then passthrough for the listed sources, then derivation when enabled, else unresolved. */
  resolve: IdentityResolver;
  /** Problems found while indexing the map (invalid ids, conflicting rows). Rows involved fail closed. */
  issues: MappingIssue[];
}

export interface IdentityIndexOptions {
  /** Sources whose keys are already canonical ids (the simulation namespace). */
  passthroughSources?: readonly string[];
  /** Derive ids for keys absent from the map (default true). Disabled: absent keys are `unresolved`. */
  deriveUnmapped?: boolean;
}

/**
 * Index an identity map and compose the resolver. Detects: one key mapped to several canonical ids; distinct keys of
 * the same source and type sharing a canonical id without `declaredAlias`; invalid canonical ids; and a derived or
 * passthrough id colliding with a crosswalk id owned by a different key. All of these resolve to `conflict`.
 */
export function createIdentityIndex(map: IdentityMap, options: IdentityIndexOptions = {}): IdentityIndex {
  const passthrough = new Set(options.passthroughSources ?? []);
  const deriveUnmapped = options.deriveUnmapped ?? true;
  const issues: MappingIssue[] = [];

  const idsByKey = new Map<string, Set<string>>();
  const keysById = new Map<string, Map<string, IdentityMapEntry>>();
  const invalidKeys = new Set<string>();
  const keyOf = new Map<string, SourceKey>();
  for (const e of map.entries) {
    const ks = sourceKeyString(e.key);
    keyOf.set(ks, e.key);
    if (!isValidCanonicalId(e.canonicalId)) {
      invalidKeys.add(ks);
      issues.push({ severity: "error", code: "INVALID_CANONICAL_ID", sourceRef: e.key, message: `crosswalk id "${e.canonicalId}" is not a valid canonical id` });
      continue;
    }
    (idsByKey.get(ks) ?? idsByKey.set(ks, new Set()).get(ks)!).add(e.canonicalId);
    (keysById.get(e.canonicalId) ?? keysById.set(e.canonicalId, new Map()).get(e.canonicalId)!).set(ks, e);
  }

  const conflicts = new Map<string, { candidates: string[]; reason: string }>();
  for (const [ks, ids] of idsByKey) {
    if (ids.size > 1) conflicts.set(ks, { candidates: [...ids].sort(), reason: "one key maps to several canonical ids" });
  }
  for (const [id, entries] of keysById) {
    // Distinct keys of one source and type sharing an id are only allowed when declared as aliases.
    const groups = new Map<string, IdentityMapEntry[]>();
    for (const e of entries.values()) {
      const g = `${e.key.sourceId}\u0000${e.key.entityType}`;
      (groups.get(g) ?? groups.set(g, []).get(g)!).push(e);
    }
    for (const g of groups.values()) {
      if (g.length > 1 && !g.every((e) => e.declaredAlias)) {
        for (const e of g) conflicts.set(sourceKeyString(e.key), { candidates: [id], reason: `keys of one source and type share ${id} without declaredAlias` });
      }
    }
  }
  for (const [ks, c] of conflicts) {
    issues.push({ severity: "error", code: "IDENTITY_CONFLICT", sourceRef: keyOf.get(ks), message: `${c.reason} (${c.candidates.join(", ")})` });
  }

  const resolve: IdentityResolver = (key): IdentityResolution => {
    const ks = sourceKeyString(key);
    const conflict = conflicts.get(ks);
    if (conflict) return { status: "conflict", candidates: conflict.candidates, reason: conflict.reason };
    if (invalidKeys.has(ks)) return { status: "unresolved", reason: "crosswalk entry has an invalid canonical id" };
    const mapped = idsByKey.get(ks);
    if (mapped) return { status: "resolved", canonicalId: [...mapped][0] };

    const fallback = passthrough.has(key.sourceId) ? passthroughResolver(key) : deriveUnmapped ? derivedResolver(key) : null;
    if (!fallback) return { status: "unresolved", reason: `no crosswalk entry for ${key.sourceId}/${key.entityType}/${key.key}` };
    if (fallback.status !== "resolved") return fallback;

    // A generated id must not land on a crosswalk id that belongs to a different key.
    const owners = keysById.get(fallback.canonicalId);
    if (owners && !owners.has(ks)) {
      return { status: "conflict", candidates: [fallback.canonicalId], reason: `generated id ${fallback.canonicalId} is owned by a crosswalk entry for another key` };
    }
    return fallback;
  };

  return { resolve, issues };
}

/** Group keys that resolve to the same canonical id (test and audit helper; ignores unresolved and conflicts). */
export function findCollisions(keys: readonly SourceKey[], resolve: IdentityResolver): { canonicalId: string; keys: SourceKey[] }[] {
  const byId = new Map<string, Map<string, SourceKey>>();
  for (const k of keys) {
    const r = resolve(k);
    if (r.status !== "resolved") continue;
    (byId.get(r.canonicalId) ?? byId.set(r.canonicalId, new Map()).get(r.canonicalId)!).set(sourceKeyString(k), k);
  }
  return [...byId].filter(([, m]) => m.size > 1).map(([canonicalId, m]) => ({ canonicalId, keys: [...m.values()] }));
}
