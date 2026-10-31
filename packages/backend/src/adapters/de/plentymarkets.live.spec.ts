import * as adapter from "./plentymarkets.json";

type Tool = {
  name: string;
  enabled?: boolean;
  parameters: { required?: string[]; properties?: Record<string, unknown> };
  endpointMapping: {
    method: string;
    path: string;
    body?: Record<string, string>;
    queryParams?: Record<string, string>;
  };
};

const tools = (adapter as unknown as { tools: Tool[] }).tools;
const tool = (name: string) => tools.find((t) => t.name === name) as Tool;

describe("plentymarkets adapter — static spec conformance", () => {
  it("prefixes every tool with plentymarkets_", () => {
    for (const t of tools) {
      expect(t.name).toMatch(/^plentymarkets_/);
    }
  });

  it("uses LOGIN_TOKEN auth configuration", () => {
    const conn = (adapter as unknown as { connector: { authType: string; authConfig: Record<string, unknown> } }).connector;
    expect(conn.authType).toBe("LOGIN_TOKEN");
    expect(conn.authConfig.loginUrl).toBe("{{PLENTY_URL}}/rest/login");
    expect(conn.authConfig.tokenJsonPath).toBe("access_token");
    expect(conn.authConfig.expiryJsonPath).toBe("expires_in");
    expect(conn.authConfig.expiryFormat).toBe("ttl_seconds");
    expect(conn.authConfig.refreshOn401).toBe(true);
  });

  it("disables destructive update tool by default", () => {
    const updateTool = tool("plentymarkets_update_order_status");
    expect(updateTool).toBeDefined();
    expect(updateTool.enabled).toBe(false);
    expect(updateTool.endpointMapping.method).toBe("PUT");
    expect(updateTool.endpointMapping.path).toBe("/orders/{{orderId}}");
  });

  it.each([
    ["plentymarkets_list_warehouses", "GET", "/stockmanagement/warehouses"],
    ["plentymarkets_list_orders", "GET", "/orders"],
    ["plentymarkets_get_order", "GET", "/orders/{{orderId}}"],
    ["plentymarkets_list_variations", "GET", "/items/variations"],
    ["plentymarkets_list_stock", "GET", "/stockmanagement/stock"],
    ["plentymarkets_list_contacts", "GET", "/accounts/contacts"],
    ["plentymarkets_get_contact", "GET", "/accounts/contacts/{{contactId}}"]
  ])("maps %s to %s %s", (name, method, path) => {
    const t = tool(name);
    expect(t).toBeDefined();
    expect(t.endpointMapping.method).toBe(method);
    expect(t.endpointMapping.path).toBe(path);
  });
});
