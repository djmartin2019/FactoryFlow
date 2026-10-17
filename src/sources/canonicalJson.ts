/**
 * Canonical JSON for content equality (plan 7.4): sorted keys, normalized numbers and timestamps.
 * Two records are the same content exactly when their canonical strings are equal. The digest is a display and audit
 * aid only (it is not collision-proof), so a collision can never hide a conflict.
 */

/** Explicit-zone ISO date-time: `2026-09-01T08:00:00Z`, `...00.5+02:00`, up to 9 fraction digits. */
const ISO_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parse an ISO date-time that carries an explicit zone into epoch ms, or `null` when it is not one or is not a real
 * instant. Unlike `Date.parse`, impossible dates (`02-31`) and `24:00:00` are rejected rather than rolled over.
 * Sub-millisecond digits are truncated (timestamps are normalized to ms).
 */
export function parseIsoInstant(text: string): number | null {
  const m = ISO_WITH_ZONE.exec(text);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const ms = m[7] ? Number(m[7].padEnd(3, "0").slice(0, 3)) : 0;
  const zone = m[8];
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const zh = Number(zone.slice(1, 3));
    const zm = Number(zone.slice(4, 6));
    if (zh > 23 || zm > 59) return null;
    offsetMinutes = (zone[0] === "-" ? -1 : 1) * (zh * 60 + zm);
  }
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const local = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const check = new Date(local);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return local - offsetMinutes * 60_000;
}

/** Normalize a timestamp string to `YYYY-MM-DDTHH:mm:ss.sssZ`, or `null` when it is not an explicit-zone instant. */
export function normalizeTimestamp(text: string): string | null {
  const ms = parseIsoInstant(text);
  return ms === null ? null : new Date(ms).toISOString();
}

function normalize(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number at ${path || "$"}`);
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case "string":
      return JSON.stringify(normalizeTimestamp(value) ?? value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v, i) => normalize(v === undefined ? null : v, `${path}.${i}`)).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new TypeError(`canonicalJson: unsupported object at ${path || "$"}`);
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${normalize(v, `${path}.${k}`)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path || "$"}`);
  }
}

/**
 * Serialize `value` canonically: object keys sorted, `undefined` properties omitted, `-0` as `0`, explicit-zone
 * timestamp strings rewritten to UTC ms form. Throws `TypeError` on non-finite numbers and non-plain objects: that is
 * a programming error in an adapter, not bad source data (validate first).
 */
export function canonicalJson(value: unknown): string {
  return normalize(value, "");
}

export function canonicalEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * 64-bit content digest as 16 hex digits: two independent 32-bit lanes (FNV-1a, and a multiply-xorshift mix) over UTF-8.
 * For `contentKey` display and audit only; it is not collision-proof and never decides equality. Integer-only (`Math.imul`),
 * which keeps it fast enough to run on every record of a 4.6k-event log (a BigInt FNV-64 cost ~10x more).
 */
export function contentDigest(canonical: string): string {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  const mix = (byte: number): void => {
    a = Math.imul(a ^ byte, 0x01000193);
    b = Math.imul(b ^ byte, 0x5bd1e995);
    b ^= b >>> 15;
  };
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i);
    if (c < 0x80) {
      mix(c);
    } else {
      // Non-ASCII: hash the UTF-8 bytes of this code point (surrogate pairs together).
      const cp = canonical.codePointAt(i)!;
      if (cp > 0xffff) i++;
      for (const byte of new TextEncoder().encode(String.fromCodePoint(cp))) mix(byte);
    }
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

/** `contentKey` of a normalized record. */
export function contentKeyOf(value: unknown): string {
  return contentDigest(canonicalJson(value));
}
