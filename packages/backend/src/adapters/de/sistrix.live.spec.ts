import axios from "axios";
import * as adapter from "./sistrix.json";
import { RestEngine } from "../../connectors/engines/rest.engine";
import { OAuth2TokenService } from "../../connectors/engines/oauth2-token.service";
import { LoginTokenService } from "../../connectors/engines/login-token.service";
import { describeErrorWhenProblems } from "../../connectors/engines/response-error.util";
import { deriveToolAnnotations } from "../../mcp-server/tool-annotations";
import { applySchemaDefaults } from "../../common/schema-defaults.util";
import {
  interpolateConnectorConfig,
  interpolateDeep,
} from "../../common/env-interpolation.util";
import { findSecretInQueryParam } from "../../common/secret-literals.util";
import {
  applyResponseTransform,
  validateTransform,
} from "../../connectors/response-transform.util";
import { describeAdapterEnvVars } from "../env-var-meta";
import { getAdapter, listAdapters } from "../catalog";

/**
 * Two layers of verification for the SISTRIX adapter:
 *
 *   1. Static: always runs. Pins the key as the api_key query parameter added
 *      by QUERY_AUTH from the encrypted authConfig, every tool's method and
 *      query parameters through the real RestEngine against the SISTRIX API
 *      documentation (sistrix.com/api, fetched 14 Oct 2026), the small default
 *      limits that keep the credit cost down, the error rules, and the
 *      shaping of the documented example answers.
 *
 *   2. Live: skipped unless RUN_SISTRIX_LIVE=1. Without a key it checks that
 *      SISTRIX refuses a wrong key with 403 and its JSON error. With
 *      SISTRIX_API_KEY it reads the credits (free) and one Visibility Index
 *      value (1 credit):
 *
 *        RUN_SISTRIX_LIVE=1 SISTRIX_API_KEY=... npx jest src/adapters/de/sistrix.live.spec.ts
 */

jest.mock("axios", () => {
  const actual = jest.requireActual("axios");
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, {
      __actual: actual.default,
    }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Schema = { description?: string; default?: unknown; enum?: unknown[] };
type Tool = {
  name: string;
  description: string;
  parameters: { properties?: Record<string, Schema>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
  };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  region: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
    config: { errorWhen: unknown };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

const BASE = "https://api.sistrix.com";
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = "f".repeat(32);
const ENV: Record<string, string> = { SISTRIX_API_KEY: FAKE_KEY };

const call = (name: string, params: Record<string, unknown>, env = ENV) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine(
    {} as OAuth2TokenService,
    {} as LoginTokenService,
  ).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
      errorWhen: a.connector.config.errorWhen,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[0][0];
const shape = (name: string, raw: unknown) =>
  applyResponseTransform(raw, tool(name).responseMapping as any);

// API method and documented parameters of each tool (api_key aside; the
// address object is one of domain, host, path or url). The links.list regex
// filters and the ranking distribution's country are in the parameter tables,
// not in the sandbox form.
const DOC: Record<string, { method: string; params: string[] }> = {
  sistrix_get_credits: { method: "credits", params: ["format"] },
  sistrix_list_countries: { method: "countries", params: ["format"] },
  sistrix_domain_overview: {
    method: "domain.overview",
    params: ["domain", "host", "path", "url", "country", "format"],
  },
  sistrix_visibility_index: {
    method: "domain.visibilityindex",
    params: [
      "domain",
      "host",
      "path",
      "url",
      "country",
      "history",
      "limit",
      "daily",
      "date",
      "format",
    ],
  },
  sistrix_keyword_count: {
    method: "domain.kwcount.seo",
    params: [
      "domain",
      "host",
      "path",
      "url",
      "country",
      "limit",
      "history",
      "date",
      "format",
    ],
  },
  sistrix_ranking_distribution: {
    method: "domain.ranking.distribution",
    params: [
      "country",
      "domain",
      "host",
      "path",
      "url",
      "history",
      "percent",
      "date",
      "format",
    ],
  },
  sistrix_competitors: {
    method: "domain.competitors.seo",
    params: ["domain", "host", "path", "url", "country", "limit", "format"],
  },
  sistrix_ranking_keywords: {
    method: "keyword.domain.seo",
    params: [
      "domain",
      "host",
      "path",
      "url",
      "country",
      "date",
      "ai_answer",
      "serp_feature",
      "limit",
      "offset",
      "search",
      "from_pos",
      "to_pos",
      "regex_keyword",
      "regex_url",
      "regex_host",
      "format",
    ],
  },
  sistrix_top_urls: {
    method: "domain.urls",
    params: [
      "domain",
      "host",
      "path",
      "url",
      "country",
      "limit",
      "offset",
      "date",
      "regex_url",
      "format",
    ],
  },
  sistrix_traffic_estimation: {
    method: "domain.traffic.estimation",
    params: [
      "domain",
      "host",
      "path",
      "url",
      "country",
      "limit",
      "offset",
      "format",
    ],
  },
  sistrix_keyword_opportunities: {
    method: "domain.opportunities",
    params: [
      "domain",
      "host",
      "path",
      "url",
      "country",
      "limit",
      "offset",
      "format",
    ],
  },
  sistrix_keyword_serp: {
    method: "keyword.seo",
    params: [
      "kw",
      "country",
      "limit",
      "history",
      "domain",
      "url",
      "date",
      "format",
    ],
  },
  sistrix_keyword_metrics: {
    method: "keyword.seo.metrics",
    params: ["kw", "country", "format"],
  },
  sistrix_keyword_traffic: {
    method: "keyword.seo.traffic",
    params: ["kw", "country", "show-all", "show-all-countries", "format"],
  },
  sistrix_keyword_questions: {
    method: "keyword.questions",
    params: ["kw", "country", "lang", "limit", "page", "format"],
  },
  sistrix_links_overview: {
    method: "links.overview",
    params: ["domain", "host", "path", "url", "format"],
  },
  sistrix_backlinks: {
    method: "links.list",
    params: [
      "regex_link_from",
      "regex_link_to",
      "regex_link_text",
      "domain",
      "host",
      "path",
      "url",
      "offset",
      "limit",
      "regex_keyword",
      "format",
    ],
  },
  sistrix_link_texts: {
    method: "links.linktexts",
    params: ["domain", "host", "path", "url", "limit", "format"],
  },
};

// Documented price: credits per call (fixed) or per row returned.
const PRICE: Record<string, RegExp> = {
  sistrix_get_credits: /Free/,
  sistrix_list_countries: /Free/,
  sistrix_domain_overview: /Costs 5 credits\./,
  sistrix_keyword_metrics: /Costs 5 credits per keyword\./,
  sistrix_links_overview: /Costs 25 credits\./,
  sistrix_backlinks: /1 credit per link returned, at most 250 credits/,
};

describe("sistrix adapter: static spec conformance", () => {
  beforeEach(() => mockedAxios.mockReset());

  it("is listed: checked against vendor SDKs, specs and working clients on 14 Oct 2026, filed under de/analytics with its own logo", () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe("sistrix");
    expect(a.region).toBe("de");
    expect(a.category).toBe("analytics");
    expect(a.icon).toBe("sistrix");
  });

  it("sends the key as the api_key query parameter from the encrypted authConfig, never as a literal", () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe("QUERY_AUTH");
    expect(a.connector.authConfig).toEqual({ api_key: "{{SISTRIX_API_KEY}}" });
    expect(a.requiredEnvVars).toEqual(["SISTRIX_API_KEY"]);
    const [meta] = describeAdapterEnvVars(a as never);
    expect(meta).toMatchObject({
      name: "SISTRIX_API_KEY",
      kind: "credential",
      secret: true,
      required: true,
    });
    expect(findSecretInQueryParam("api_key", "{{SISTRIX_API_KEY}}")).toEqual(
      [],
    );
    for (const t of a.tools) {
      expect(Object.keys(t.endpointMapping.queryParams ?? {})).not.toContain(
        "api_key",
      );
      expect(Object.keys(t.parameters.properties ?? {})).not.toContain(
        "api_key",
      );
    }
  });

  it("accepts a plain key and refuses pasted query strings or spaces", () => {
    const key = new RegExp(a.envVarMeta.SISTRIX_API_KEY.pattern!);
    expect(key.test(FAKE_KEY)).toBe(true);
    for (const bad of ["", `api_key=${FAKE_KEY}`, `${FAKE_KEY} `, "short"])
      expect(key.test(bad)).toBe(false);
  });

  it("checks the connection on the free credits function and explains the error codes", () => {
    expect(a.connector.healthcheckPath).toBe("/credits");
    expect(a.probe).toEqual({ tool: "sistrix_get_credits" });
    for (const status of ["401", "403", "429"])
      expect(a.verifyHints[status]).toBeTruthy();
  });

  it("prefixes every tool with sistrix_, shares no tool name with another adapter, and is all reads", () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    expect([...mine].sort()).toEqual(Object.keys(DOC).sort());
    for (const name of mine) expect(name).toMatch(/^sistrix_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools)
        expect(mine.has(t.name)).toBe(false);
    }
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe("GET");
      expect(
        deriveToolAnnotations({
          name: t.name,
          connectorType: "REST",
          endpointMapping: t.endpointMapping,
          annotations: t.annotations,
        }).readOnlyHint,
      ).toBe(true);
    }
  });

  it.each(Object.keys(DOC))(
    "%s calls its documented method with documented parameters, JSON and a small limit",
    (name) => {
      const doc = DOC[name];
      const t = tool(name);
      const qp = t.endpointMapping.queryParams!;
      const props = t.parameters.properties ?? {};
      expect(t.endpointMapping.path).toBe(`/${doc.method}`);
      expect(qp.format).toBe("json");
      for (const k of Object.keys(qp)) expect(doc.params).toContain(k);
      for (const value of Object.values(qp)) {
        if (typeof value === "string" && value.startsWith("$"))
          expect(props).toHaveProperty(value.slice(1));
      }
      if (props.limit) expect(props.limit.default).toBe(10);
      expect(t.description).toMatch(
        PRICE[name] ?? /Costs 1 credit per [A-Za-z]+ returned/,
      );
    },
  );

  it("only points the model at tools that exist, documents setup, credits and the official MCP server, and writes no em dashes", () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bsistrix_[a-z_]+/g),
      ...a.tools.flatMap((t) => [
        ...t.description.matchAll(/\bsistrix_[a-z_]+/g),
      ]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain("https://app.sistrix.com/account/api");
    expect(a.instructions).toMatch(/Every call spends SISTRIX API credits/);
    expect(a.instructions).toContain("https://api.sistrix.com/mcp/");
    expect(a.instructions).toMatch(/Out of scope/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(
          `${t.name}.${p}:string`,
        );
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it("carries valid response mappings and error rules", () => {
    expect(describeErrorWhenProblems(a.connector.config.errorWhen)).toEqual([]);
    for (const t of a.tools) {
      expect(validateTransform(t.responseMapping!.transform)).toBeNull();
      expect(t.responseMapping!.transform.maxBytes).toBeGreaterThan(0);
    }
  });

  it.each<[string, Record<string, unknown>, string, Record<string, unknown>]>([
    ["sistrix_get_credits", {}, "credits", {}],
    ["sistrix_list_countries", {}, "countries", {}],
    [
      "sistrix_domain_overview",
      { domain: "sistrix.de" },
      "domain.overview",
      { domain: "sistrix.de" },
    ],
    [
      "sistrix_visibility_index",
      { domain: "sistrix.de", history: true },
      "domain.visibilityindex",
      { domain: "sistrix.de", history: true, limit: 10 },
    ],
    [
      "sistrix_keyword_count",
      { host: "www.sistrix.de", country: "at" },
      "domain.kwcount.seo",
      { host: "www.sistrix.de", country: "at", limit: 10 },
    ],
    [
      "sistrix_ranking_distribution",
      { domain: "sistrix.de", percent: true },
      "domain.ranking.distribution",
      { domain: "sistrix.de", percent: true },
    ],
    [
      "sistrix_competitors",
      { domain: "sistrix.de" },
      "domain.competitors.seo",
      { domain: "sistrix.de", limit: 10 },
    ],
    [
      "sistrix_ranking_keywords",
      { path: "www.sistrix.de/news/", from_pos: 1, to_pos: 10 },
      "keyword.domain.seo",
      { path: "www.sistrix.de/news/", from_pos: 1, to_pos: 10, limit: 10 },
    ],
    [
      "sistrix_top_urls",
      { domain: "sistrix.de" },
      "domain.urls",
      { domain: "sistrix.de", limit: 10 },
    ],
    [
      "sistrix_traffic_estimation",
      { domain: "sistrix.de" },
      "domain.traffic.estimation",
      { domain: "sistrix.de", limit: 10 },
    ],
    [
      "sistrix_keyword_opportunities",
      { url: "https://www.sistrix.de/" },
      "domain.opportunities",
      { url: "https://www.sistrix.de/", limit: 10 },
    ],
    [
      "sistrix_keyword_serp",
      { kw: "seo tool" },
      "keyword.seo",
      { kw: "seo tool", limit: 10 },
    ],
    [
      "sistrix_keyword_metrics",
      { kw: "seo tool", country: "de" },
      "keyword.seo.metrics",
      { kw: "seo tool", country: "de" },
    ],
    [
      "sistrix_keyword_traffic",
      { kw: "seo tool", show_all: true },
      "keyword.seo.traffic",
      { kw: "seo tool", "show-all": true },
    ],
    [
      "sistrix_keyword_questions",
      { kw: "sistrix", lang: "de" },
      "keyword.questions",
      { kw: "sistrix", lang: "de", limit: 10 },
    ],
    [
      "sistrix_links_overview",
      { domain: "sistrix.de" },
      "links.overview",
      { domain: "sistrix.de" },
    ],
    [
      "sistrix_backlinks",
      { domain: "sistrix.de" },
      "links.list",
      { domain: "sistrix.de", limit: 10 },
    ],
    [
      "sistrix_link_texts",
      { domain: "sistrix.de" },
      "links.linktexts",
      { domain: "sistrix.de", limit: 10 },
    ],
  ])(
    "%s calls the right URL with the key, JSON and the small default limit",
    async (name, params, method, query) => {
      mockedAxios.mockResolvedValue({
        data: { answer: [{}], credits: [{ used: 0 }] },
        headers: {},
      });
      await call(name, params);
      const req = sent();
      expect(req.method).toBe("GET");
      expect(req.url).toBe(`${BASE}/${method}`);
      expect(req.params).toEqual({
        api_key: FAKE_KEY,
        format: "json",
        ...query,
      });
      expect(req.headers["User-Agent"]).toBe("AnythingMCP");
    },
  );

  // Example answers of the SISTRIX API sandbox (sistrix.com/docs, no key).
  it("shapes a Visibility Index answer to answer, info and the credits used", () => {
    const raw = {
      method: [["domain.sichtbarkeitsindex"]],
      info: [{ country: "de", device: "mobile", domain: "sistrix.de" }],
      answer: [
        {
          sichtbarkeitsindex: [
            { domain: "sistrix.de", date: "2026-10-12", value: 1.111 },
          ],
        },
      ],
      credits: [{ used: 1 }],
    };
    expect(shape("sistrix_visibility_index", raw).value).toEqual({
      info: { country: "de", device: "mobile", domain: "sistrix.de" },
      answer: {
        sichtbarkeitsindex: [
          { domain: "sistrix.de", date: "2026-10-12", value: 1.111 },
        ],
      },
      credits_used: 1,
    });
  });

  it("keeps the week of a ranking-keywords answer and the remaining credits of the credits answer", () => {
    const kw = {
      method: [["keyword.domain.seo"]],
      info: [{ country: "de", device: "mobile", domain: "sistrix.de" }],
      answer: [
        {
          result: [
            {
              kw: "sistrix",
              position: 1,
              competition: 55,
              traffic: 9999,
              url: "https://www.sistrix.de/",
            },
          ],
        },
      ],
      date: [["2026-10-12"]],
      credits: [{ used: 1 }],
    };
    expect(shape("sistrix_ranking_keywords", kw).value).toMatchObject({
      date: "2026-10-12",
      credits_used: 1,
      answer: { result: [expect.objectContaining({ kw: "sistrix" })] },
    });
    const credits = {
      method: [["credits"]],
      answer: [{ credits: [{ value: 99999 }] }],
      credits: [{ used: 0 }],
    };
    expect(shape("sistrix_get_credits", credits).value).toEqual({
      answer: { credits: [{ value: 99999 }] },
      credits_used: 0,
    });
  });

  it("turns an error body that arrives with HTTP 200 into a classified failure", async () => {
    const body = (code: number, message: string) => ({
      data: {
        status: "error",
        error: [{ error_code: code, error_message: message }],
      },
      headers: {},
    });
    for (const [code, message, status] of [
      [100, "wrong api key", 401],
      [200, "not enough credits", 403],
      [5000, "package does not contain api access", 403],
      [429, "too many requests", 429],
      [2000, "domain not found", 404],
      [1003, "missing parameters", 400],
      [500, "internal error", 502],
    ] as const) {
      mockedAxios.mockReset();
      mockedAxios.mockResolvedValue(body(code, message));
      await expect(
        call("sistrix_domain_overview", { domain: "sistrix.de" }),
      ).rejects.toMatchObject({
        status,
        message: expect.stringContaining(message),
      });
    }
  });
});

const live = process.env.RUN_SISTRIX_LIVE ? describe : describe.skip;
live("sistrix adapter: live", () => {
  const realKey = process.env.SISTRIX_API_KEY;
  beforeAll(() =>
    mockedAxios.mockImplementation((cfg: any) =>
      (mockedAxios.__actual as any).request(cfg),
    ),
  );
  afterAll(() => mockedAxios.mockReset());

  it("refuses a wrong key with 403 and the JSON error shape the rules read", async () => {
    const expected = {
      response: {
        status: 403,
        data: {
          status: "error",
          error: [{ error_code: 403, error_message: "Permission denied" }],
        },
      },
    };
    await expect(call("sistrix_get_credits", {})).rejects.toMatchObject(
      expected,
    );
    await expect(
      call("sistrix_domain_overview", { domain: "sistrix.de" }),
    ).rejects.toMatchObject(expected);
  }, 30000);

  (realKey ? it : it.skip)(
    "reads the credits (free) and one Visibility Index value (1 credit)",
    async () => {
      const env = { SISTRIX_API_KEY: realKey! };
      const credits = shape(
        "sistrix_get_credits",
        await call("sistrix_get_credits", {}, env),
      ).value as any;
      expect(credits.answer.credits[0].value).toBeGreaterThanOrEqual(0);
      const vi = shape(
        "sistrix_visibility_index",
        await call(
          "sistrix_visibility_index",
          { domain: "sistrix.de", country: "de" },
          env,
        ),
      ).value as any;
      expect(vi.answer.sichtbarkeitsindex[0].domain).toBe("sistrix.de");
      expect(vi.credits_used).toBe(1);
    },
    60000,
  );
});
