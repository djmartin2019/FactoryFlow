/**
 * Customer-order detail (slice S5): one order with its lines, finished-goods allocations, shipments and the work orders
 * planned to satisfy it. The work-order link is a PLANNING link (`ProductionOrder.demandLineIds`), not proven unit flow:
 * finished goods are allocated to order lines from stock, so no shipment can be traced to a particular work order.
 * Dispatch figures come from `dispatchReport`, so the numbers here are the Dispatch tab's numbers.
 */
import type { Id } from "../manufacturing/types.ts";
import { categoryOf } from "./workOrders.ts";
import { dispatchReport, type OrderDispatchView } from "./dispatch.ts";
import type { ReportingSnapshot, WorkOrderCategory } from "./types.ts";

export interface CustomerOrderLineView {
  lineId: Id;
  lineNumber: number;
  productId: Id;
  sku: string;
  productName: string;
  quantity: number;
  /** Finished goods reserved for the line and not yet dispatched. */
  allocatedQuantity: number;
  shippedQuantity: number;
  unshippedQuantity: number;
}

export interface AllocationView {
  eventId: Id;
  timestampMs: number;
  lineId: Id;
  quantity: number;
}

export interface ShipmentView {
  id: Id;
  dispatchedAtMs: number;
  carrier: string;
  lines: Array<{ lineId: Id; sku: string; quantity: number }>;
  /** Dispatched on or before the order's due date (dispatch basis). */
  onTime: boolean;
}

export interface PlannedWorkOrderView {
  id: Id;
  productId: Id;
  sku: string;
  quantity: number;
  status: string;
  category: WorkOrderCategory;
  createdAtMs: number;
  completedAtMs: number | null;
  /** The order lines this work order was planned to satisfy. */
  lineIds: Id[];
}

export interface CustomerOrderDetail {
  orderId: Id;
  customerId: Id;
  customerName: string;
  /** The Dispatch tab's figures for this order (lead time, lateness, past due, segments, ...). */
  dispatch: OrderDispatchView;
  demandDriver: string;
  lines: CustomerOrderLineView[];
  allocations: AllocationView[];
  shipments: ShipmentView[];
  plannedWorkOrders: PlannedWorkOrderView[];
}

/** Null when the order does not exist at the snapshot time. */
export function customerOrderDetail(snapshot: ReportingSnapshot, orderId: Id): CustomerOrderDetail | null {
  const { state, master, asOfMs } = snapshot;
  const order = state.customerOrders[orderId];
  if (!order || Date.parse(order.createdAt) > asOfMs) return null;
  const dispatch = dispatchReport(snapshot, "all").orders.find((o) => o.orderId === orderId);
  if (!dispatch) return null;

  const product = (id: Id) => master.products.find((p) => p.id === id);
  const lineIds = new Set(order.lines.map((l) => l.id));
  const dueMs = Date.parse(order.dueDate);

  const lines: CustomerOrderLineView[] = order.lines.map((l) => ({
    lineId: l.id,
    lineNumber: l.lineNumber,
    productId: l.productId,
    sku: product(l.productId)?.sku ?? l.productId,
    productName: product(l.productId)?.name ?? l.productId,
    quantity: l.quantity,
    allocatedQuantity: l.allocatedQuantity,
    shippedQuantity: l.shippedQuantity,
    unshippedQuantity: l.quantity - l.shippedQuantity,
  }));

  const allocations: AllocationView[] = [];
  for (const e of snapshot.events) {
    if (e.type !== "FINISHED_GOODS_ALLOCATED" || e.payload.customerOrderId !== orderId) continue;
    const timestampMs = Date.parse(e.timestamp);
    if (timestampMs > asOfMs) continue;
    allocations.push({ eventId: e.id, timestampMs, lineId: e.payload.customerOrderLineId, quantity: e.payload.quantity });
  }

  const shipments: ShipmentView[] = Object.values(state.shipments)
    .filter((s) => s.customerOrderId === orderId && Date.parse(s.dispatchedAt) <= asOfMs)
    .sort((a, b) => Date.parse(a.dispatchedAt) - Date.parse(b.dispatchedAt) || a.id.localeCompare(b.id))
    .map((s) => ({
      id: s.id,
      dispatchedAtMs: Date.parse(s.dispatchedAt),
      carrier: s.carrier,
      lines: s.lines.map((l) => ({ lineId: l.customerOrderLineId, sku: product(l.productId)?.sku ?? l.productId, quantity: l.quantity })),
      onTime: Date.parse(s.dispatchedAt) <= dueMs,
    }));

  const plannedWorkOrders: PlannedWorkOrderView[] = Object.values(state.productionOrders)
    .filter((wo) => wo.demandLineIds.some((id) => lineIds.has(id)))
    .map((wo) => ({
      id: wo.id,
      productId: wo.productId,
      sku: product(wo.productId)?.sku ?? wo.productId,
      quantity: wo.quantity,
      status: wo.status,
      category: categoryOf(wo),
      createdAtMs: Date.parse(wo.createdAt),
      completedAtMs: wo.completedAt ? Date.parse(wo.completedAt) : null,
      lineIds: wo.demandLineIds.filter((id) => lineIds.has(id)).sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return { orderId, customerId: order.customerId, customerName: dispatch.customerName, dispatch, demandDriver: order.demandDriver, lines, allocations, shipments, plannedWorkOrders };
}
