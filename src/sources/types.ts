/**
 * Source-integration contracts (M1 of docs/SOURCE_INTEGRATION_PLAN_REV3.md, sections 7.2 to 7.8).
 *
 * Types only, plus two tiny constant tables. Nothing here runs business rules, touches the reducer or reads a clock.
 * Adapters turn raw source data into `CanonicalInput`; ingest (M3b) turns accepted business events into the
 * `FactoryEvent` log. Existing domain types stay the canonical vocabulary and are imported, not redefined.
 */
import type { EventPayloads, EventType, Id, IsoTimestamp } from "../manufacturing/types.ts";

// ---------------------------------------------------------------------------
// Unknown is not zero (P1)
// ---------------------------------------------------------------------------

/** A field a source may state, may omit, or may not be able to supply at all. Never coerced to a default. */
export type Known<T> = { state: "known"; value: T } | { state: "unknown" } | { state: "unsupported" };

export const known = <T>(value: T): Known<T> => ({ state: "known", value });
export const UNKNOWN: Known<never> = { state: "unknown" };
export const UNSUPPORTED: Known<never> = { state: "unsupported" };

// ---------------------------------------------------------------------------
// Identity (7.3)
// ---------------------------------------------------------------------------

/** The domain's own entity names (`EventEntityRefs` and `FactoryState` collections). */
export type EntityType =
  | "supplier"
  | "customer"
  | "product"
  | "material"
  | "location"
  | "workstation"
  | "equipment"
  | "purchaseOrder"
  | "receipt"
  | "inventoryTransfer"
  | "customerOrder"
  | "productionOrder"
  | "productionOperation"
  | "workstationAssignment"
  | "qualityInspection"
  | "shipment"
  | "downtime";

export const ENTITY_TYPES: readonly EntityType[] = [
  "supplier", "customer", "product", "material", "location", "workstation", "equipment", "purchaseOrder", "receipt",
  "inventoryTransfer", "customerOrder", "productionOrder", "productionOperation", "workstationAssignment",
  "qualityInspection", "shipment", "downtime",
];

/** Tenant/site exist so the key shape never has to change later; nothing enforces them yet. */
export interface SourceScope {
  tenantId?: string;
  siteId?: string;
}

/** A source-native identifier. Equality is over every field, so "1042" in two systems never collides. */
export interface SourceKey {
  sourceId: string;
  entityType: EntityType;
  key: string;
  scope?: SourceScope;
}

export type IdentityResolution =
  | { status: "resolved"; canonicalId: Id }
  | { status: "unresolved"; reason: string }
  | { status: "conflict"; candidates: Id[]; reason: string };

/** Pure: the same key always yields the same resolution for a given resolver/map. */
export type IdentityResolver = (key: SourceKey) => IdentityResolution;

/** One crosswalk row. `declaredAlias` allows several keys of one source and type to share a canonical id. */
export interface IdentityMapEntry {
  key: SourceKey;
  canonicalId: Id;
  declaredAlias?: boolean;
}

/** A versioned, content-identified input artifact (no file format yet). */
export interface IdentityMap {
  version: string;
  entries: readonly IdentityMapEntry[];
}

// ---------------------------------------------------------------------------
// Capabilities and provenance (7.8)
// ---------------------------------------------------------------------------

export type InputKind = "business_event" | "snapshot_observation" | "cdc_change";

export type Origin = "simulated_event" | "source_business_event" | "cdc_change" | "snapshot_observation" | "manual_correction";

export type OrdinalSemantics = "none" | "posting" | "causal" | "adapter_derived";

export interface SourceCapabilities {
  inputKinds: readonly InputKind[];
  entities: Partial<Record<EntityType, "full" | "partial" | "none">>;
  /** Meaning of `sourceOrdinal` within one stream (7.5). Never compared across streams. */
  ordinal: OrdinalSemantics;
  versioning: "none" | "monotonic";
  timePrecision: "ms" | "second" | "minute" | "day";
  liveUpdates: boolean;
  historyQuery: boolean;
}

export type OccurredAtQuality = "reported" | "observed_proxy" | "unknown";

/**
 * What an adapter knows about a record. `ingestedAt` is deliberately absent: it is injected by ingest
 * (`StampedProvenance`), so adapters stay pure functions of (raw, identity map, context) and no clock enters the core.
 */
export interface InputProvenance {
  sourceId: string;
  streamId: string;
  /** With `sourceId`, the idempotency key. */
  sourceEventId: string;
  sourceOrdinal?: number | string;
  sourceVersion?: number | string;
  occurredAt: IsoTimestamp | null;
  occurredAtQuality: OccurredAtQuality;
  observedAt: IsoTimestamp | null;
  origin: Origin;
  schemaVersion: string;
  adapterVersion: string;
  identityMapVersion: string;
  /** Digest of the canonical normalized content: display and audit only; equality uses the canonical JSON itself. */
  contentKey: string;
  /** Pointer or hash of the raw source record. */
  rawRef: string;
}

/** Provenance once ingest has seen the record. `ingestedAt` never takes part in ordering, hashes or equality. */
export interface StampedProvenance extends InputProvenance {
  ingestedAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Canonical inputs (7.7)
// ---------------------------------------------------------------------------

/** The arguments of `buildEvent` without `sequence`: ingest assigns the sequence and id. */
export type EventDraft = { [K in EventType]: { type: K; timestamp: IsoTimestamp; payload: EventPayloads[K] } }[EventType];

/** A source states "X happened at T". The only input kind that can reach the reducer. */
export interface BusinessEventInput {
  kind: "business_event";
  provenance: InputProvenance;
  draft: EventDraft;
}

/** "Entity E looked like this at `observedAt`." Retained and reported, never turned into events. */
export interface SnapshotObservationInput {
  kind: "snapshot_observation";
  provenance: InputProvenance;
  entityType: EntityType;
  entityId: Id;
  fields: Readonly<Record<string, Known<unknown>>>;
}

/** A row changed at commit time. Evidence of a data change, not a business event. */
export interface CdcChangeInput {
  kind: "cdc_change";
  provenance: InputProvenance;
  entityType: EntityType;
  entityId: Id;
  operation: "insert" | "update" | "delete";
  before?: Readonly<Record<string, unknown>>;
  after?: Readonly<Record<string, unknown>>;
}

export type CanonicalInput = BusinessEventInput | SnapshotObservationInput | CdcChangeInput;

// ---------------------------------------------------------------------------
// Issues, quarantine, persisted decisions (7.4, 7.5, 7.8)
// ---------------------------------------------------------------------------

export interface RecordRef {
  sourceId: string;
  sourceEventId: string;
}

export interface MappingIssue {
  severity: "error" | "warning" | "info";
  code: string;
  sourceRef?: SourceKey | RecordRef;
  /** Dotted path into the raw record, e.g. `lines.0.qty`. */
  path?: string;
  message: string;
}

/** Rule classes of docs/REDUCER_RULES.md. */
export type RuleClass = "LOG" | "REFERENCE" | "INTEGRITY" | "PLAN_CONFORMANCE" | "AMBIGUOUS";

export const RULE_CLASSES: readonly RuleClass[] = ["LOG", "REFERENCE", "INTEGRITY", "PLAN_CONFORMANCE", "AMBIGUOUS"];

export type QuarantineCode =
  | "DUPLICATE_CONFLICT"
  | "AMBIGUOUS_ORDER"
  | "SOURCE_ORDER_CONTRADICTION"
  | "REFERENCES_FUTURE_ENTITY"
  | "UNPLACEABLE_TIME"
  | "UNRESOLVED_IDENTITY"
  | "IDENTITY_CONFLICT"
  | "INVARIANT_VIOLATION" // split into typed, classified codes in M7
  | "INTERNAL_ERROR";

/** Quarantine is a status, not a verdict: the record stays in the ledger and is re-evaluated on every ingest. */
export interface QuarantineRecord {
  ref: RecordRef;
  reason: { code: QuarantineCode; message: string; class?: RuleClass; members?: RecordRef[] };
  recoverable: boolean;
  firstSeenAt: IsoTimestamp;
}

/** Picks the winning member of a conflicting duplicate group, or none. Timestamps are metadata only. */
export interface ConflictResolution {
  ref: RecordRef;
  choice: { kind: "member"; contentKey: string } | { kind: "none" };
  reason: string;
  decidedBy: string;
  decidedAt: IsoTimestamp;
}

/** An explicit total order of interacting records that no source ordinal could order. */
export interface OrderHint {
  /** Earliest first. */
  members: readonly RecordRef[];
  reason: string;
  decidedBy: string;
  decidedAt: IsoTimestamp;
}
