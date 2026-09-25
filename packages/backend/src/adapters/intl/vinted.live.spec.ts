import * as adapter from "./vinted.json";
import { ConfigService } from "@nestjs/config";
import { RestEngine } from "../../connectors/engines/rest.engine";
import { OAuth2TokenService } from "../../connectors/engines/oauth2-token.service";
import { LoginTokenService } from "../../connectors/engines/login-token.service";
import { applyResponseTransform } from "../../connectors/response-transform.util";
import { compile as jmespathCompile } from "@jmespath-community/jmespath";

/**
 * Two-layer verification for the vinted adapter:
 *
 *   1. Static — always runs. Locks in the API Vinted's website uses since
 *      September 2026 (api.vinted.fr/svc-catalogue, /svc-filters) and the
 *      anonymous session bootstrap. The adapter shipped against
 *      www.vinted.fr/api/v2/catalog/items with no token at all and never
 *      returned a single successful call: first 401 invalid_authentication_token,
 *      then 404 once Vinted retired the route.
 *
 *   2. Live — opt-in, because it calls Vinted. Runs the real engine, including
 *      the LOGIN_TOKEN cookie bootstrap, and checks the mapped shapes.
 *      Run with:  VINTED_LIVE=1 npx jest src/adapters/intl/vinted.live.spec.ts
 *      From a datacenter address it is the check that matters: Cloudflare
 *      challenges www.vinted.fr/ there, but not /catalog.
 */

const a = adapter as unknown as {
  slug: string;
  selfHostOnly?: boolean;
  requiredEnvVars: string[];
  probe?: { tool: string; params: Record<string, unknown> };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
  };
  tools: Array<{
    name: string;
    useProxy?: boolean;
    endpointMapping: {
      method: string;
      path: string;
      queryParams?: Record<string, string>;
    };
    responseMapping?: { transform?: { mode?: string; expression?: string } };
  }>;
};

describe("vinted adapter — static spec conformance", () => {
  it("has the expected slug + non-empty tool set", () => {
    expect(a.slug).toBe("vinted");
    expect(a.connector.baseUrl).toMatch(/^https:\/\//);
    expect(a.tools.length).toBeGreaterThan(0);
  });

  it("all tools have a name starting with the adapter slug prefix", () => {
    const prefix = a.slug.replace(/-/g, "_");
    a.tools.forEach((t) => expect(t.name.startsWith(prefix + "_")).toBe(true));
  });

  it("targets the api.vinted.fr services, not the retired www /api/v2 routes", () => {
    expect(a.connector.baseUrl).toBe("https://api.vinted.fr");
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe("GET");
      expect(t.endpointMapping.path).toMatch(/^\/svc-(catalogue|filters)\//);
    }
    expect(JSON.stringify([a.connector, a.tools])).not.toMatch(/\/api\/v2\//);
  });

  it("bootstraps the anonymous session from /catalog, which datacenter IPs can reach", () => {
    const cfg = a.connector.authConfig;
    expect(a.connector.authType).toBe("LOGIN_TOKEN");
    expect(a.requiredEnvVars).toEqual([]);
    // www.vinted.fr/ answers a Cloudflare challenge from the cloud droplet.
    expect(cfg.loginUrl).toBe("https://www.vinted.fr/catalog");
    // HEAD: the cookie is all we need, the page itself is 7 MB.
    expect(cfg.loginMethod).toBe("HEAD");
    expect(cfg.loginBody).toBeNull();
    expect(cfg.tokenSource).toBe("cookie");
    expect(cfg.cookieName).toBe("access_token_web");
    // The token is a 24 h JWT; renew well before and on any 401.
    expect(cfg.tokenTTLSeconds as number).toBeLessThan(86400);
    expect(cfg.proactiveRefreshSeconds as number).toBeLessThan(
      cfg.tokenTTLSeconds as number,
    );
    expect(cfg.refreshOn401).toBe(true);
  });

  it("is offered on the cloud and calls Vinted directly", () => {
    expect(a.selfHostOnly).toBeUndefined();
    expect(a.tools.some((t) => t.useProxy === true)).toBe(false);
    expect(a.probe?.tool).toBe("vinted_search_items");
  });

  it("sends filters as attribute_ids[...] (the old *_ids names are silently ignored)", () => {
    const q = a.tools.find((t) => t.name === "vinted_search_items")!
      .endpointMapping.queryParams!;
    expect(q["attribute_ids[brand]"]).toBe("$brand_ids");
    expect(q["attribute_ids[catalog]"]).toBe("$catalog_ids");
    expect(q["attribute_ids[status]"]).toBe("$status_ids");
    expect(Object.keys(q)).not.toContain("brand_ids");
  });

  it("every tool ships a JMESPath mapping that compiles", () => {
    for (const t of a.tools) {
      const tf = t.responseMapping?.transform;
      expect(tf?.mode).toBe("jmespath");
      expect(() => jmespathCompile(tf!.expression!)).not.toThrow();
    }
  });
});

const maybe = process.env.VINTED_LIVE ? describe : describe.skip;

maybe("vinted adapter — live smoke test", () => {
  const prisma = {
    connectorAuthCache: {
      findUnique: async () => null,
      upsert: async () => null,
    },
  };
  const config = {
    get: () => "live-test-encryption-key-32-chars!",
  } as unknown as ConfigService;
  const login = new LoginTokenService(prisma as any, config);
  const engine = new RestEngine({} as unknown as OAuth2TokenService, login);

  const cfg = {
    baseUrl: a.connector.baseUrl,
    authType: a.connector.authType,
    authConfig: a.connector.authConfig,
  };
  const tool = (n: string) => a.tools.find((t) => t.name === n)!;
  const run = async (n: string, params: Record<string, unknown>) => {
    const raw = await engine.execute(
      cfg as any,
      tool(n).endpointMapping as any,
      params,
    );
    const out = applyResponseTransform(raw, tool(n).responseMapping);
    expect(out.applied).toBe(true);
    return out.value as any;
  };

  it("search_items: compact items, filters applied, page 2 not empty", async () => {
    const res = await run("vinted_search_items", {
      search_text: "jacket",
      per_page: 5,
      brand_ids: "362",
      status_ids: "6",
    });
    expect(res.items.length).toBeGreaterThan(0);
    const it0 = res.items[0];
    expect(it0.brand).toMatch(/Carhartt/);
    expect(it0.url).toMatch(/^https:\/\/www\.vinted\.fr\/items\/\d+/);
    expect(Number(it0.price)).toBeGreaterThan(0);
    expect(it0.currency).toBe("EUR");
    const page2 = await run("vinted_search_items", {
      search_text: "jacket",
      per_page: 5,
      page: 2,
    });
    expect(page2.items.length).toBeGreaterThan(0);
    expect(page2.pagination.current_page).toBe(2);
  }, 30000);

  it("get_filters: brand options with ids and counts", async () => {
    const res = await run("vinted_get_filters", {
      filter_code: "brand",
      search_text: "carhartt",
    });
    expect(res.filter_code).toBe("brand");
    expect(res.options.find((o: any) => o.id === "362")?.title).toBe(
      "Carhartt",
    );
  }, 30000);

  it("get_categories: top-level categories with ids", async () => {
    const res = await run("vinted_get_categories", {});
    expect(res.length).toBeGreaterThan(0);
    expect(res.some((c: any) => c.id === "5")).toBe(true);
  }, 30000);
});
