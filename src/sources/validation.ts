/**
 * Runtime-validation primitives for adapters (plan decision D1: zod, scoped to `src/sources`).
 *
 * Uses `zod/mini`: the same engine and error model as classic zod, but tree-shakable (about 8 KB gzipped for a typical
 * adapter against about 27 KB for the classic API, measured in docs/PERFORMANCE.md). Do not re-export the `z` namespace
 * from here or from `index.ts`: that defeats tree-shaking and pulls in the whole library (about 100 KB gzipped).
 *
 * `validate` never throws: it turns a zod failure into `MappingIssue`s with a dotted path and a stable code, so an
 * adapter can report a bad record and carry on. The primitive schemas encode the conversions the plan requires at the
 * boundary (explicit-zone timestamps normalized to UTC ms, seconds to integer minutes, source status codes to canonical
 * ones) and refuse to guess: a missing field, a wrong unit or an unknown code is an issue, never a default.
 */
import * as z from "zod/mini";
import { normalizeTimestamp } from "./canonicalJson.ts";
import type { Known, MappingIssue, RecordRef, SourceKey } from "./types.ts";

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: MappingIssue[] };

/** Stable issue codes produced by `validate`. */
export type ValidationCode =
  | "MISSING_FIELD"
  | "WRONG_TYPE"
  | "UNKNOWN_FIELD"
  | "UNKNOWN_CODE"
  | "BAD_TIMESTAMP"
  | "BAD_UNIT"
  | "OUT_OF_RANGE"
  | "INVALID_VALUE";

/** Custom-issue codes a schema can raise through `fail(ctx, code, message)`; anything else becomes INVALID_VALUE. */
const CUSTOM_CODES = new Set<string>(["BAD_TIMESTAMP", "BAD_UNIT", "OUT_OF_RANGE", "UNKNOWN_CODE"]);

/** The value at `path` in `raw`, or `undefined` when any step is absent (zod does not report the offending input). */
function valueAt(raw: unknown, path: readonly PropertyKey[]): unknown {
  let cur = raw;
  for (const step of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[step];
  }
  return cur;
}

function codeFor(issue: z.core.$ZodIssue, raw: unknown): ValidationCode {
  switch (issue.code) {
    case "invalid_type":
      return valueAt(raw, issue.path) === undefined ? "MISSING_FIELD" : "WRONG_TYPE";
    case "unrecognized_keys":
      return "UNKNOWN_FIELD";
    case "invalid_value":
      return "UNKNOWN_CODE";
    case "too_small":
    case "too_big":
      return "OUT_OF_RANGE";
    case "custom": {
      const code = (issue.params as { code?: string } | undefined)?.code;
      return code && CUSTOM_CODES.has(code) ? (code as ValidationCode) : "INVALID_VALUE";
    }
    default:
      return "INVALID_VALUE";
  }
}

const pathText = (path: readonly PropertyKey[]): string | undefined => (path.length === 0 ? undefined : path.map(String).join("."));

/** Validate `raw`; on failure return one `MappingIssue` per problem, never throwing. */
export function validate<T>(schema: z.ZodMiniType<T>, raw: unknown, sourceRef?: SourceKey | RecordRef): ValidationResult<T> {
  let result: ReturnType<typeof schema.safeParse>;
  try {
    result = schema.safeParse(raw);
  } catch (err) {
    // A transform that throws is an adapter bug; still report it instead of escaping.
    return { ok: false, issues: [{ severity: "error", code: "INTERNAL_ERROR", sourceRef, message: (err as Error).message }] };
  }
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      severity: "error" as const,
      code: codeFor(issue, raw),
      sourceRef,
      path: pathText(issue.path),
      message: issue.message,
    })),
  };
}

/** Raise an issue with a stable code from inside a `refine`/`transform`. */
export function fail(ctx: z.core.ParsePayload, code: ValidationCode, message: string): typeof z.NEVER {
  ctx.issues.push({ code: "custom", message, input: ctx.value, params: { code } });
  return z.NEVER;
}

// ---------------------------------------------------------------------------
// Primitive schemas
// ---------------------------------------------------------------------------

/** Non-empty string (ids, keys). Whitespace is not trimmed: "A" and "A " are different keys. */
export const nonEmptyString = z.string().check(z.minLength(1, "must not be empty"));

/** Timestamp with an explicit zone (`Z` or an offset), normalized to `YYYY-MM-DDTHH:mm:ss.sssZ`. Zone-less text is refused. */
export const isoTimestamp = z.pipe(
  z.string(),
  z.transform((text, ctx) => {
    const normalized = normalizeTimestamp(text);
    if (normalized === null) return fail(ctx, "BAD_TIMESTAMP", `"${text}" is not an ISO 8601 instant with an explicit zone (Z or +hh:mm)`);
    return normalized;
  }),
);

export const nonNegativeInt = z.number().check(z.int("must be an integer"), z.gte(0, "must not be negative"));
export const positiveInt = z.number().check(z.int("must be an integer"), z.gte(1, "must be positive"));

/** Integer US cents. Decimal currency amounts must be converted by the adapter, not rounded here. */
export const cents = nonNegativeInt;

/** Durations arrive in seconds and become integer minutes. Anything that is not a whole number of minutes is a unit error. */
export const durationSeconds = z.pipe(
  z.number(),
  z.transform((seconds, ctx) => {
    if (!Number.isInteger(seconds) || seconds < 0) return fail(ctx, "BAD_UNIT", `${seconds} is not a non-negative whole number of seconds`);
    if (seconds % 60 !== 0) return fail(ctx, "BAD_UNIT", `${seconds} s is not a whole number of minutes (domain durations are integer minutes)`);
    return seconds / 60;
  }),
);

/**
 * Map source codes to canonical values, e.g. `codeMap({ RUN: "RUNNING", IDLE: "IDLE", DOWN: "DOWN" })`.
 * An unlisted code is an `UNKNOWN_CODE` issue, never a default.
 */
export function codeMap<const M extends Record<string, string>>(mapping: M) {
  return z.pipe(
    z.string(),
    z.transform((code, ctx): M[keyof M] => {
      if (!Object.hasOwn(mapping, code)) {
        return fail(ctx, "UNKNOWN_CODE", `unknown code "${code}" (expected one of ${Object.keys(mapping).join(", ")})`) as never;
      }
      return mapping[code] as M[keyof M];
    }),
  );
}

/** `Known<T>` for observation fields: `known` carries a validated value; the other two states carry nothing. */
export function knownOf<T>(value: z.ZodMiniType<T>): z.ZodMiniType<Known<T>> {
  return z.discriminatedUnion("state", [
    z.object({ state: z.literal("known"), value }),
    z.object({ state: z.literal("unknown") }),
    z.object({ state: z.literal("unsupported") }),
  ]) as unknown as z.ZodMiniType<Known<T>>;
}

/** Strict object: unexpected keys are `UNKNOWN_FIELD` issues, so a renamed source field cannot go unnoticed. */
export const strictObject = <S extends z.core.$ZodShape>(shape: S) => z.strictObject(shape);
