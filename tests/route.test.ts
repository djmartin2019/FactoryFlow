import { describe, expect, it } from "vitest";
import { EXPLORER_TABS, formatRoute, parseRoute, type Route } from "../src/ui/route.ts";

describe("deep-link routes", () => {
  it("round-trips every view, tab and entity", () => {
    const routes: Route[] = [
      { view: "overview" },
      ...EXPLORER_TABS.map((tab): Route => ({ view: "explorer", tab })),
      { view: "explorer", tab: "orders", entity: { kind: "work-order", id: "WO-0001" } },
      { view: "explorer", tab: "dispatch", entity: { kind: "customer-order", id: "CO-0042" } },
    ];
    for (const r of routes) expect(parseRoute(formatRoute(r)), formatRoute(r)).toEqual(r);
  });

  it("formats the documented URLs", () => {
    expect(formatRoute({ view: "overview" })).toBe("#/overview");
    expect(formatRoute({ view: "explorer", tab: "quality" })).toBe("#/explorer/quality");
    expect(formatRoute({ view: "explorer", tab: "orders", entity: { kind: "work-order", id: "WO-0007" } })).toBe("#/explorer/orders/WO-0007");
    expect(formatRoute({ view: "explorer", tab: "dispatch", entity: { kind: "customer-order", id: "CO-0003" } })).toBe("#/explorer/dispatch/CO-0003");
  });

  it("omits an entity that does not belong to the tab", () => {
    expect(formatRoute({ view: "explorer", tab: "quality", entity: { kind: "work-order", id: "WO-0001" } })).toBe("#/explorer/quality");
    expect(formatRoute({ view: "explorer", tab: "orders", entity: { kind: "customer-order", id: "CO-0001" } })).toBe("#/explorer/orders");
  });

  it("treats a bare explorer route as the work-order tab and accepts a missing leading slash", () => {
    expect(parseRoute("#/explorer")).toEqual({ view: "explorer", tab: "orders" });
    expect(parseRoute("#explorer/bom")).toEqual({ view: "explorer", tab: "bom" });
    expect(parseRoute("explorer/bom")).toEqual({ view: "explorer", tab: "bom" });
  });

  it("refuses anything that is not a valid route, so the default view is kept", () => {
    for (const bad of [
      "",
      "#",
      "#/",
      "#/nope",
      "#/overview/extra",
      "#/explorer/unknown-tab",
      "#/explorer/orders/WO-1/extra",
      "#/explorer/quality/WO-0001", // entity on a tab that has none
      "#/explorer/orders/%E0%A4%A", // malformed percent-encoding
      "#/explorer/orders/WO 1",
      "#/explorer/orders/<script>",
      "#/explorer/orders/../../etc",
      `#/explorer/orders/${"A".repeat(65)}`,
    ]) {
      expect(parseRoute(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
