/**
 * Deep-link routes (S5). Pure string handling: no DOM, no simulation. The URL records WHAT is on screen (view, Explorer tab and
 * the selected work order or customer order). It does not record simulated time: an entity that does not exist yet at the current
 * simulated time shows a "does not exist yet" message and fills in once the clock reaches it.
 *
 *   #/overview
 *   #/explorer/<tab>
 *   #/explorer/orders/<work order id>
 *   #/explorer/dispatch/<customer order id>
 */
export const EXPLORER_TABS = ["orders", "dispatch", "quality", "shortages", "analytics", "workcenters", "bom", "inventory"] as const;
export type ExplorerTab = (typeof EXPLORER_TABS)[number];

export type EntityRef = { kind: "work-order"; id: string } | { kind: "customer-order"; id: string };

export type Route = { view: "overview" } | { view: "explorer"; tab: ExplorerTab; entity?: EntityRef };

/** Ids are letters, digits, dot, underscore and hyphen (WO-0001, CO-0042). Anything else is refused, never interpreted. */
const ID = /^[A-Za-z0-9._-]{1,64}$/;

export const entityTab = (e: EntityRef): ExplorerTab => (e.kind === "work-order" ? "orders" : "dispatch");

export function formatRoute(r: Route): string {
  if (r.view === "overview") return "#/overview";
  const base = `#/explorer/${r.tab}`;
  if (!r.entity || entityTab(r.entity) !== r.tab) return base;
  return `${base}/${encodeURIComponent(r.entity.id)}`;
}

/** Parses a location hash; returns null for anything that is not a valid route (the caller then keeps the default view). */
export function parseRoute(hash: string): Route | null {
  const parts = hash.replace(/^#\/?/, "").split("/").filter((p) => p.length > 0);
  if (parts[0] === "overview" && parts.length === 1) return { view: "overview" };
  if (parts[0] !== "explorer" || parts.length > 3) return null;
  if (parts.length === 1) return { view: "explorer", tab: "orders" };
  const tab = parts[1] as ExplorerTab;
  if (!(EXPLORER_TABS as readonly string[]).includes(tab)) return null;
  if (parts.length === 2) return { view: "explorer", tab };
  let id: string;
  try {
    id = decodeURIComponent(parts[2]);
  } catch {
    return null;
  }
  if (!ID.test(id)) return null;
  if (tab === "orders") return { view: "explorer", tab, entity: { kind: "work-order", id } };
  if (tab === "dispatch") return { view: "explorer", tab, entity: { kind: "customer-order", id } };
  return null;
}
