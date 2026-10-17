/**
 * Simulation adapter: untrusted wire records in, `CanonicalInput` out (plan 7.1, 7.7, 7.11).
 *
 * It parses and validates, normalizes timestamps, units and status codes, checks that ids are valid canonical ids (the
 * simulation namespace is passthrough: ids are already canonical), attaches provenance and ordinal, and reports
 * `MappingIssue`s. It applies no business rules, never calls the reducer and invents no defaults: a record that does not
 * validate yields issues and no input. The simulation's `seq` is a `causal` ordinal within stream `sim`.
 */
import * as z from "zod/mini";
import { contentKeyOf } from "../canonicalJson.ts";
import type { EventType, InitialStateFile } from "../../manufacturing/types.ts";
import type { BusinessEventInput, EventDraft, MappingIssue, SourceCapabilities } from "../types.ts";
import { isoTimestamp, nonEmptyString, positiveInt, strictObject, validate } from "../validation.ts";
import { SIM_SOURCE_ID, SIM_STREAM_ID, SIM_WIRE_VERSION } from "./wire.ts";
import { EVENT_KINDS, payloadEntity, simulationCodec } from "./wireSpec.ts";

export const SIM_ADAPTER_VERSION = "sim-adapter/1";

/** What the simulation can and cannot say (plan 7.8). */
export const SIM_CAPABILITIES: SourceCapabilities = {
  inputKinds: ["business_event"],
  entities: {
    supplier: "full", customer: "full", product: "full", material: "full", location: "full", workstation: "full", equipment: "full",
    purchaseOrder: "full", receipt: "full", inventoryTransfer: "full", customerOrder: "full", productionOrder: "full",
    productionOperation: "full", workstationAssignment: "full", qualityInspection: "full", shipment: "full", downtime: "full",
  },
  ordinal: "causal",
  versioning: "none",
  timePrecision: "minute",
  liveUpdates: false,
  historyQuery: true,
};

export interface AdaptContext {
  /** Version of the identity map in force (recorded in provenance). The simulation namespace is passthrough. */
  identityMapVersion: string;
}

export type AdaptResult<T> = { ok: true; value: T } | { ok: false; issues: MappingIssue[] };

const EVENT_TYPE_BY_KIND = new Map<string, EventType>((Object.keys(EVENT_KINDS) as EventType[]).map((t) => [EVENT_KINDS[t], t]));

const Envelope = strictObject({
  event_id: nonEmptyString,
  event_kind: nonEmptyString,
  occurred_at: isoTimestamp,
  seq: positiveInt,
  stream: z.literal(SIM_STREAM_ID),
  payload: z.unknown(),
});

const InitialEnvelope = strictObject({
  wire_version: z.literal(SIM_WIRE_VERSION),
  domain_schema: nonEmptyString,
  master: z.unknown(),
  state: z.unknown(),
});

const withRef = (issues: MappingIssue[], sourceEventId: string | undefined): MappingIssue[] =>
  sourceEventId === undefined ? issues : issues.map((i) => ({ ...i, sourceRef: { sourceId: SIM_SOURCE_ID, sourceEventId } }));

/** Initial state and master data (M2a). */
export function adaptInitialState(wire: unknown): AdaptResult<InitialStateFile> {
  const env = validate(InitialEnvelope, wire);
  if (!env.ok) return env;
  const master = simulationCodec.decode("MasterData", env.value.master, "master");
  const state = simulationCodec.decode("FactoryState", env.value.state, "state");
  const issues = [...(master.ok ? [] : master.issues), ...(state.ok ? [] : state.issues)];
  if (issues.length > 0 || !master.ok || !state.ok) return { ok: false, issues };
  return { ok: true, value: { schemaVersion: env.value.domain_schema, master: master.value, state: state.value } as InitialStateFile };
}

/** One wire event to one canonical business event (M2b). */
export function adaptEvent(wire: unknown, ctx: AdaptContext): AdaptResult<BusinessEventInput> {
  const sourceEventId =
    typeof wire === "object" && wire !== null && typeof (wire as { event_id?: unknown }).event_id === "string" ? (wire as { event_id: string }).event_id : undefined;

  const env = validate(Envelope, wire);
  if (!env.ok) return { ok: false, issues: withRef(env.issues, sourceEventId) };
  const { event_id, event_kind, occurred_at, seq, payload } = env.value;

  const type = EVENT_TYPE_BY_KIND.get(event_kind);
  if (!type) {
    return {
      ok: false,
      issues: withRef([{ severity: "error", code: "UNKNOWN_CODE", path: "event_kind", message: `unknown event_kind "${event_kind}"` }], event_id),
    };
  }
  const decoded = simulationCodec.decode(payloadEntity(type), payload, "payload");
  if (!decoded.ok) return { ok: false, issues: withRef(decoded.issues, event_id) };

  const draft = { type, timestamp: occurred_at, payload: decoded.value } as EventDraft;
  return {
    ok: true,
    value: {
      kind: "business_event",
      provenance: {
        sourceId: SIM_SOURCE_ID,
        streamId: SIM_STREAM_ID,
        sourceEventId: event_id,
        sourceOrdinal: seq,
        occurredAt: occurred_at,
        occurredAtQuality: "reported",
        observedAt: null,
        origin: "simulated_event",
        schemaVersion: SIM_WIRE_VERSION,
        adapterVersion: SIM_ADAPTER_VERSION,
        identityMapVersion: ctx.identityMapVersion,
        contentKey: contentKeyOf(draft),
        rawRef: `${SIM_SOURCE_ID}:${event_id}`,
      },
      draft,
    },
  };
}

/** Adapt a batch. Records that fail produce issues and no input; the rest still go through. */
export function adaptEvents(wires: readonly unknown[], ctx: AdaptContext): { inputs: BusinessEventInput[]; issues: MappingIssue[] } {
  const inputs: BusinessEventInput[] = [];
  const issues: MappingIssue[] = [];
  for (const wire of wires) {
    const r = adaptEvent(wire, ctx);
    if (r.ok) inputs.push(r.value);
    else issues.push(...r.issues);
  }
  return { inputs, issues };
}
