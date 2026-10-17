/**
 * Material shortage impact (slice S4). Semantics: docs/KPI_DEFINITIONS.md ("Material shortage impact"), which is
 * authoritative.
 *
 * For every work order currently blocked by a material shortage: which materials are short NOW, by how much, and
 * what open purchase-order supply could cover each one. Observed facts as of the snapshot time; nothing here
 * predicts when an order will be released. Orders compete for the same stock and supply, and this view does NOT
 * allocate either between them, so shortfalls of different orders for one material must not be added.
 */
import type { CustomerOrder, Id, PurchaseOrder } from "../manufacturing/types.ts";
import type { ReportingSnapshot } from "./types.ts";

export type SupplyStatus =
  /** Open purchase orders, taken in promised-date order, reach the shortfall. */
  | "COVERED"
  /** Open purchase orders exist but their outstanding quantity is less than the shortfall. */
  | "NOT_COVERED"
  /** No open purchase-order quantity for the material. */
  | "NO_SUPPLY";

export interface ShortageLine {
  materialId: Id;
  sku: string;
  description: string;
  uom: string;
  /** BOM quantity x order quantity. */
  required: number;
  /** On hand minus reserved, summed over raw-storage locations, right now. */
  availableNow: number;
  /** required - availableNow (> 0). */
  shortfall: number;
  supply: {
    status: SupplyStatus;
    /** Σ (ordered - received) over open purchase-order lines for the material. */
    outstandingQuantity: number;
    /** Promised delivery of the purchase order at which cumulative outstanding quantity first reaches the shortfall; null unless COVERED. */
    coverDateMs: number | null;
    /** Purchase orders taken to reach the cover date (all outstanding ones when NOT_COVERED). */
    purchaseOrderIds: Id[];
    /** The cover date (or, when not covered, the earliest promised date) is already in the past: supply is overdue. */
    overdue: boolean;
  };
}

export interface BlockedOrderShortage {
  orderId: Id;
  productId: Id;
  sku: string;
  quantity: number;
  dueMs: number;
  /** When the order was blocked; null if not recorded. */
  blockedAtMs: number | null;
  /** Materials short at the current balances. Empty when stock has since arrived and release is merely pending. */
  lines: ShortageLine[];
  /** Customer orders this work order was planned to satisfy (a planning link, not proven unit flow). */
  customerOrderIds: Id[];
  earliestCustomerDueMs: number | null;
}

export interface MaterialSummary {
  materialId: Id;
  sku: string;
  description: string;
  /** Blocked work orders currently short of this material. */
  blockedOrders: number;
  availableNow: number;
  /** Σ outstanding quantity on open purchase orders. */
  outstandingQuantity: number;
  openPurchaseOrders: number;
  earliestPromisedMs: number | null;
  /** Open purchase orders already past their promised date. */
  overduePurchaseOrders: number;
}

export interface MaterialShortageReport {
  asOfMs: number;
  /** Work orders in status BLOCKED with reason MATERIAL_SHORTAGE: exactly the dashboard's "Blocked by material shortage" count. */
  blockedOrders: BlockedOrderShortage[];
  /** One row per material that is short for at least one blocked order. */
  byMaterial: MaterialSummary[];
}

interface Supply {
  poId: Id;
  promisedMs: number;
  outstanding: number;
}

function openSupply(purchaseOrders: Record<Id, PurchaseOrder>): Map<Id, Supply[]> {
  const map = new Map<Id, Supply[]>();
  for (const po of Object.values(purchaseOrders)) {
    if (po.status === "RECEIVED") continue;
    for (const l of po.lines) {
      const outstanding = l.orderedQuantity - l.receivedQuantity;
      if (outstanding <= 0) continue;
      const list = map.get(l.materialId) ?? [];
      list.push({ poId: po.id, promisedMs: Date.parse(po.promisedDeliveryAt), outstanding });
      map.set(l.materialId, list);
    }
  }
  for (const list of map.values()) list.sort((a, b) => a.promisedMs - b.promisedMs || a.poId.localeCompare(b.poId));
  return map;
}

export function materialShortages(snapshot: ReportingSnapshot): MaterialShortageReport {
  const { state, master, asOfMs } = snapshot;
  const rawLocations = new Set(master.locations.filter((l) => l.kind === "RAW_STORAGE").map((l) => l.id));
  const available = new Map<Id, number>();
  for (const b of Object.values(state.inventory)) {
    if (!rawLocations.has(b.locationId)) continue;
    available.set(b.itemId, (available.get(b.itemId) ?? 0) + b.onHand - b.reserved);
  }
  const supply = openSupply(state.purchaseOrders);
  const lineToOrder = new Map<Id, CustomerOrder>();
  for (const o of Object.values(state.customerOrders)) for (const l of o.lines) lineToOrder.set(l.id, o);

  const blockedOrders: BlockedOrderShortage[] = Object.values(state.productionOrders)
    .filter((o) => o.status === "BLOCKED" && o.blockReason === "MATERIAL_SHORTAGE")
    .map((o) => {
      const product = master.products.find((p) => p.id === o.productId);
      const bom = master.billsOfMaterials.find((b) => b.productId === o.productId);
      const lines: ShortageLine[] = [];
      for (const bl of bom?.lines ?? []) {
        const required = bl.quantityPer * o.quantity;
        const availableNow = available.get(bl.materialId) ?? 0;
        if (availableNow >= required) continue;
        const shortfall = required - availableNow;
        const material = master.materials.find((m) => m.id === bl.materialId);
        const open = supply.get(bl.materialId) ?? [];
        const outstandingQuantity = open.reduce((n, s) => n + s.outstanding, 0);
        let running = 0;
        const used: Supply[] = [];
        let cover: Supply | undefined;
        for (const s of open) {
          running += s.outstanding;
          used.push(s);
          if (running >= shortfall) {
            cover = s;
            break;
          }
        }
        const status: SupplyStatus = open.length === 0 ? "NO_SUPPLY" : cover ? "COVERED" : "NOT_COVERED";
        lines.push({
          materialId: bl.materialId,
          sku: material?.sku ?? bl.materialId,
          description: material?.description ?? bl.materialId,
          uom: material?.uom ?? "EA",
          required,
          availableNow,
          shortfall,
          supply: {
            status,
            outstandingQuantity,
            coverDateMs: cover ? cover.promisedMs : null,
            purchaseOrderIds: (cover ? used : open).map((s) => s.poId),
            overdue: status === "NO_SUPPLY" ? false : (cover ? cover.promisedMs : open[0].promisedMs) < asOfMs,
          },
        });
      }
      const customers = [...new Map(o.demandLineIds.flatMap((id) => (lineToOrder.has(id) ? [[lineToOrder.get(id)!.id, lineToOrder.get(id)!] as const] : []))).values()];
      const dues = customers.map((c) => Date.parse(c.dueDate));
      return {
        orderId: o.id,
        productId: o.productId,
        sku: product?.sku ?? o.productId,
        quantity: o.quantity,
        dueMs: Date.parse(o.dueDate),
        blockedAtMs: o.blockedAt ? Date.parse(o.blockedAt) : null,
        lines,
        customerOrderIds: customers.map((c) => c.id).sort(),
        earliestCustomerDueMs: dues.length ? Math.min(...dues) : null,
      };
    })
    .sort((a, b) => a.dueMs - b.dueMs || a.orderId.localeCompare(b.orderId));

  const counts = new Map<Id, number>();
  for (const o of blockedOrders) for (const l of o.lines) counts.set(l.materialId, (counts.get(l.materialId) ?? 0) + 1);
  const byMaterial: MaterialSummary[] = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([materialId, n]) => {
      const material = master.materials.find((m) => m.id === materialId);
      const open = supply.get(materialId) ?? [];
      return {
        materialId,
        sku: material?.sku ?? materialId,
        description: material?.description ?? materialId,
        blockedOrders: n,
        availableNow: available.get(materialId) ?? 0,
        outstandingQuantity: open.reduce((s, x) => s + x.outstanding, 0),
        openPurchaseOrders: new Set(open.map((x) => x.poId)).size,
        earliestPromisedMs: open.length ? open[0].promisedMs : null,
        overduePurchaseOrders: new Set(open.filter((x) => x.promisedMs < asOfMs).map((x) => x.poId)).size,
      };
    });

  return { asOfMs, blockedOrders, byMaterial };
}
