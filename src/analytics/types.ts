/**
 * Reporting read-model types. Presentation-independent: no DOM, no Three.js,
 * no UI imports. Inputs are canonical manufacturing records (see
 * ../manufacturing/types.ts) so a future ERP/MES adapter that produces the
 * same records can drive the same reporting without UI changes.
 */
import type { FactoryEvent, FactoryState, Id, IsoTimestamp, MasterData, ProductionOrderStatus } from "../manufacturing/types.ts";

/** Everything the reporting layer needs, as of one replay timestamp. */
export interface ReportingSnapshot {
  /** The single authoritative replay timestamp (epoch ms). */
  asOfMs: number;
  /** Start of the available history (epoch ms); reporting windows are clipped to it. */
  startMs: number;
  master: MasterData;
  state: Readonly<FactoryState>;
  /** Events applied so far, chronological. Anything after `asOfMs` is ignored defensively. */
  events: readonly FactoryEvent[];
}

/**
 * Reporting buckets, derived from the domain status:
 *  OPEN        PLANNED, WAITING, or BLOCKED before it ever started
 *  IN_PROGRESS RUNNING, or BLOCKED after it started (e.g. machine down mid-operation)
 *  COMPLETED   COMPLETED
 *  CANCELLED   CANCELLED
 */
export type WorkOrderCategory = "OPEN" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

export interface WorkOrderSummary {
  id: Id;
  productId: Id;
  sku: string;
  productName: string;
  /** Distinct customer order ids this order was planned for (may be empty). */
  customerOrderIds: Id[];
  orderedQuantity: number;
  goodQuantity: number;
  scrapQuantity: number;
  status: ProductionOrderStatus;
  category: WorkOrderCategory;
  blockReason?: string;
  /** Operation currently running/paused, or null. */
  currentOperation: { label: string; workstationId?: Id; workstationName?: string } | null;
  createdAt: IsoTimestamp;
  createdAtMs: number;
  dueDate: IsoTimestamp;
  dueMs: number;
  startedAt?: IsoTimestamp;
  completedAt?: IsoTimestamp;
  /** Completed operations / planned operations (0..1); 1 when COMPLETED. */
  progress: number;
}

export interface WorkOrderCounts {
  total: number;
  open: number;
  inProgress: number;
  completed: number;
  cancelled: number;
}

export interface RoutingStepView {
  sequence: number;
  operationType: string;
  label: string;
  isRework: boolean;
  operationId?: Id;
  /** Resolved workstation, or the kind of workstation the routing requires. */
  workstationId?: Id;
  workstationName: string;
  /** Logical work center name; absent for routings without work centers. */
  workCenter?: string;
  /** Shift minutes between the previous step completing (or order release) and this step starting. */
  waitMinutes?: number;
  /** Elapsed run time excluding machine-failure holds. */
  processingMinutes?: number;
  /** Minutes paused by machine failures. */
  holdMinutes?: number;
  status: "NOT_STARTED" | "PENDING" | "RUNNING" | "PAUSED" | "COMPLETED";
  startedAt?: IsoTimestamp;
  completedAt?: IsoTimestamp;
  /** Units processed; null until the operation has completed. */
  completedQuantity: number | null;
  plannedQuantity?: number;
}

export interface MaterialRequirementView {
  materialId: Id;
  sku: string;
  description: string;
  uom: string;
  required: number;
  /** Quantity currently reserved for this order; null when not attributable. */
  reserved: number | null;
  /** Quantity issued to this order; null when not attributable. */
  consumed: number | null;
}

export interface InspectionView {
  id: Id;
  inspectedAt: IsoTimestamp;
  round: number;
  workstationId: Id;
  workstationName: string;
  inspected: number;
  passed: number;
  failed: number;
  rework: number;
  scrap: number;
  outcome: "PASSED" | "REWORK" | "SCRAPPED" | "REWORK_AND_SCRAP";
  defects: Array<{ code: string; quantity: number }>;
  cause?: string;
}

export interface TimelineEntry {
  eventId: Id;
  sequence: number;
  timestamp: IsoTimestamp;
  type: string;
  description: string;
  where?: string;
}

export interface WorkOrderDetail {
  summary: WorkOrderSummary;
  customerOrders: Array<{ id: Id; customerName: string; status: string }>;
  approvedQuantity: number;
  reworkPendingQuantity: number;
  releasedAt?: IsoTimestamp;
  routing: RoutingStepView[];
  materials: MaterialRequirementView[];
  inspections: InspectionView[];
  reworkRequests: Array<{ timestamp: IsoTimestamp; quantity: number; inspectionId: Id }>;
  /** Chronological, truncated to the most recent `limit` entries. */
  timeline: TimelineEntry[];
  timelineTotal: number;
}

export type Granularity = "hour" | "day";

export interface ThroughputPoint {
  startMs: number;
  endMs: number;
  units: number;
  /** Good units in this bucket by product id; sums to `units`. Products with no units are absent. */
  byProduct: Record<Id, number>;
}

export interface ThroughputSeries {
  granularity: Granularity;
  fromMs: number;
  toMs: number;
  /** null = all products. */
  productId: Id | null;
  points: ThroughputPoint[];
  total: number;
  /** Good units over the whole window by product id; sums to `total`. */
  totalsByProduct: Record<Id, number>;
}
