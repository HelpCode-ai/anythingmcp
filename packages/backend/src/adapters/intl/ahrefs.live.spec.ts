import axios from "axios";
import * as adapter from "./ahrefs.json";
import { RestEngine } from "../../connectors/engines/rest.engine";
import { OAuth2TokenService } from "../../connectors/engines/oauth2-token.service";
import { LoginTokenService } from "../../connectors/engines/login-token.service";
import { deriveToolAnnotations } from "../../mcp-server/tool-annotations";
import { applySchemaDefaults } from "../../common/schema-defaults.util";
import {
  interpolateConnectorConfig,
  interpolateDeep,
} from "../../common/env-interpolation.util";
import {
  applyResponseTransform,
  validateTransform,
} from "../../connectors/response-transform.util";
import { describeAdapterEnvVars } from "../env-var-meta";
import { getAdapter, listAdapters } from "../catalog";

/**
 * Two layers of verification for the Ahrefs adapter:
 *
 *   1. Static: always runs. Pins the Bearer key from the encrypted authConfig,
 *      every tool's path, query parameters and request body through the real
 *      RestEngine against Ahrefs' OpenAPI spec (docs.ahrefs.com/openapi.json,
 *      fetched 14 Oct 2026): documented parameter names, required parameters,
 *      the default `select` columns, and the small default `limit` that keeps
 *      the unit cost down.
 *
 *   2. Live: skipped unless RUN_AHREFS_LIVE=1. Without a key it checks that
 *      Ahrefs refuses a wrong key with 401 and a missing one with 403. With
 *      AHREFS_API_KEY it runs only Ahrefs' free requests: the limits endpoint
 *      and the documented free test queries (target ahrefs.com, keyword
 *      ahrefs or yep), so it spends no API units:
 *
 *        RUN_AHREFS_LIVE=1 AHREFS_API_KEY=... npx jest src/adapters/intl/ahrefs.live.spec.ts
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
    bodyMapping?: Record<string, unknown>;
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
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

const BASE = "https://api.ahrefs.com/v3";
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = "f".repeat(40);
const ENV: Record<string, string> = { AHREFS_API_KEY: FAKE_KEY };

const call = (
  name: string,
  params: Record<string, unknown>,
  env = ENV,
  authType = a.connector.authType,
) => {
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
      authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[0][0];
const shape = (name: string, raw: unknown) =>
  applyResponseTransform(raw, tool(name).responseMapping as any);

// Path, documented parameters (without `output`) and required parameters of
// each endpoint in the OpenAPI spec.
const DOC: Record<
  string,
  { path: string; params: string[]; required: string[] }
> = {
  ahrefs_get_limits_and_usage: {
    path: "/subscription-info/limits-and-usage",
    params: [],
    required: [],
  },
  ahrefs_domain_rating: {
    path: "/site-explorer/domain-rating",
    params: ["date", "target"],
    required: ["date", "target"],
  },
  ahrefs_backlinks_stats: {
    path: "/site-explorer/backlinks-stats",
    params: ["date", "mode", "target", "portfolio_id", "protocol"],
    required: ["date", "target"],
  },
  ahrefs_site_metrics: {
    path: "/site-explorer/metrics",
    params: [
      "date",
      "mode",
      "target",
      "portfolio_id",
      "protocol",
      "country",
      "volume_mode",
      "traffic_mode",
    ],
    required: ["date", "target"],
  },
  ahrefs_metrics_history: {
    path: "/site-explorer/metrics-history",
    params: [
      "select",
      "mode",
      "target",
      "portfolio_id",
      "protocol",
      "country",
      "date_from",
      "date_to",
      "history_grouping",
      "volume_mode",
      "traffic_mode",
    ],
    required: ["target", "date_from"],
  },
  ahrefs_domain_rating_history: {
    path: "/site-explorer/domain-rating-history",
    params: ["target", "date_from", "date_to", "history_grouping"],
    required: ["target", "date_from"],
  },
  ahrefs_backlinks: {
    path: "/site-explorer/all-backlinks",
    params: [
      "select",
      "where",
      "order_by",
      "limit",
      "timeout",
      "aggregation",
      "history",
      "mode",
      "target",
      "portfolio_id",
      "protocol",
    ],
    required: ["select", "target"],
  },
  ahrefs_referring_domains: {
    path: "/site-explorer/refdomains",
    params: [
      "select",
      "where",
      "order_by",
      "limit",
      "timeout",
      "history",
      "mode",
      "target",
      "portfolio_id",
      "protocol",
    ],
    required: ["select", "target"],
  },
  ahrefs_anchors: {
    path: "/site-explorer/anchors",
    params: [
      "select",
      "where",
      "order_by",
      "limit",
      "timeout",
      "history",
      "mode",
      "target",
      "portfolio_id",
      "protocol",
    ],
    required: ["select", "target"],
  },
  ahrefs_organic_keywords: {
    path: "/site-explorer/organic-keywords",
    params: [
      "select",
      "where",
      "order_by",
      "limit",
      "timeout",
      "volume_mode",
      "traffic_mode",
      "date",
      "date_compared",
      "country",
      "mode",
      "target",
      "portfolio_id",
      "protocol",
    ],
    required: ["select", "date", "target"],
  },
  ahrefs_top_pages: {
    path: "/site-explorer/top-pages",
    params: [
      "select",
      "where",
      "order_by",
      "limit",
      "timeout",
      "volume_mode",
      "traffic_mode",
      "date",
      "date_compared",
      "country",
      "mode",
      "target",
      "portfolio_id",
      "protocol",
    ],
    required: ["select", "date", "target"],
  },
  ahrefs_organic_competitors: {
    path: "/site-explorer/organic-competitors",
    params: [
      "select",
      "where",
      "order_by",
      "limit",
      "timeout",
      "volume_mode",
      "traffic_mode",
      "date",
      "date_compared",
      "country",
      "mode",
      "target",
      "portfolio_id",
      "protocol",
    ],
    required: ["select", "date", "country", "target"],
  },
  ahrefs_keywords_overview: {
    path: "/keywords-explorer/overview",
    params: [
      "select",
      "where",
      "order_by",
      "limit",
      "timeout",
      "keyword_list_id",
      "keywords",
      "country",
      "target_position",
      "target",
      "mode",
      "volume_monthly_date_from",
      "volume_monthly_date_to",
    ],
    required: ["select", "country"],
  },
  ahrefs_matching_terms: {
    path: "/keywords-explorer/matching-terms",
    params: [
      "select",
      "where",
      "order_by",
      "limit",
      "timeout",
      "keyword_list_id",
      "keywords",
      "country",
      "terms",
      "match_mode",
    ],
    required: ["select", "country"],
  },
  ahrefs_related_terms: {
    path: "/keywords-explorer/related-terms",
    params: [
      "select",
      "where",
      "order_by",
      "limit",
      "timeout",
      "keyword_list_id",
      "keywords",
      "country",
      "terms",
      "view_for",
    ],
    required: ["select", "country"],
  },
  ahrefs_volume_history: {
    path: "/keywords-explorer/volume-history",
    params: ["keyword", "country", "date_from", "date_to"],
    required: ["keyword", "country"],
  },
  ahrefs_serp_overview: {
    path: "/serp-overview/serp-overview",
    params: ["select", "keyword", "country", "date", "top_positions", "type"],
    required: ["select", "keyword", "country"],
  },
  ahrefs_batch_analysis: {
    path: "/batch-analysis/batch-analysis",
    params: [
      "select",
      "order_by",
      "targets",
      "volume_mode",
      "country",
      "top_countries",
    ],
    required: ["select", "targets"],
  },
};

// Columns each endpoint with `select` can return (its response schema).
const COLUMNS: Record<string, string[]> = {
  ahrefs_metrics_history: [
    "date",
    "org_cost",
    "org_traffic",
    "paid_cost",
    "paid_traffic",
  ],
  ahrefs_backlinks: [
    "ahrefs_rank_source",
    "ahrefs_rank_target",
    "alt",
    "anchor",
    "broken_redirect_new_target",
    "broken_redirect_reason",
    "broken_redirect_source",
    "class_c",
    "discovered_status",
    "domain_rating_source",
    "domain_rating_target",
    "drop_reason",
    "encoding",
    "first_seen",
    "first_seen_link",
    "http_code",
    "http_crawl",
    "ip_source",
    "is_alternate",
    "is_canonical",
    "is_content",
    "is_dofollow",
    "is_form",
    "is_frame",
    "is_image",
    "is_lost",
    "is_new",
    "is_nofollow",
    "is_redirect",
    "is_redirect_lost",
    "is_root_source",
    "is_root_target",
    "is_rss",
    "is_spam",
    "is_sponsored",
    "is_text",
    "is_ugc",
    "js_crawl",
    "languages",
    "last_seen",
    "last_visited",
    "link_group_count",
    "link_type",
    "linked_domains_source_domain",
    "linked_domains_source_page",
    "linked_domains_target_domain",
    "links_external",
    "links_internal",
    "lost_reason",
    "name_source",
    "name_target",
    "noindex",
    "page_category_source",
    "page_size",
    "page_type_source",
    "port_source",
    "port_target",
    "positions",
    "powered_by",
    "redirect_code",
    "redirect_kind",
    "refdomains_source",
    "refdomains_source_domain",
    "refdomains_target_domain",
    "root_name_source",
    "root_name_target",
    "snippet_left",
    "snippet_right",
    "source_page_author",
    "source_page_publish_date",
    "title",
    "tld_class_source",
    "tld_class_target",
    "traffic",
    "traffic_domain",
    "url_from",
    "url_from_plain",
    "url_rating_source",
    "url_redirect",
    "url_redirect_with_target",
    "url_to",
    "url_to_plain",
  ],
  ahrefs_referring_domains: [
    "dofollow_linked_domains",
    "dofollow_links",
    "dofollow_refdomains",
    "domain",
    "domain_rating",
    "first_seen",
    "ip_source",
    "is_root_domain",
    "is_spam",
    "last_seen",
    "links_to_target",
    "lost_links",
    "new_links",
    "positions_source_domain",
    "traffic_domain",
  ],
  ahrefs_anchors: [
    "anchor",
    "dofollow_links",
    "first_seen",
    "is_spam",
    "last_seen",
    "links_to_target",
    "lost_links",
    "new_links",
    "refdomains",
    "refpages",
    "top_domain_rating",
  ],
  ahrefs_organic_keywords: [
    "all_positions",
    "all_positions_prev",
    "best_position",
    "best_position_diff",
    "best_position_has_thumbnail",
    "best_position_has_thumbnail_prev",
    "best_position_has_video",
    "best_position_has_video_prev",
    "best_position_kind",
    "best_position_kind_merged",
    "best_position_kind_prev",
    "best_position_prev",
    "best_position_set",
    "best_position_set_prev",
    "best_position_url",
    "best_position_url_prev",
    "cpc",
    "cpc_merged",
    "cpc_prev",
    "entities",
    "is_best_position_set_top_3",
    "is_best_position_set_top_3_prev",
    "is_best_position_set_top_4_10",
    "is_best_position_set_top_4_10_prev",
    "is_best_position_set_top_11_50",
    "is_best_position_set_top_11_50_prev",
    "is_branded",
    "is_commercial",
    "is_informational",
    "is_local",
    "is_navigational",
    "is_transactional",
    "keyword",
    "keyword_country",
    "keyword_difficulty",
    "keyword_difficulty_merged",
    "keyword_difficulty_prev",
    "keyword_language",
    "keyword_merged",
    "keyword_prev",
    "language",
    "language_prev",
    "last_update",
    "last_update_prev",
    "serp_features",
    "serp_features_count",
    "serp_features_count_prev",
    "serp_features_merged",
    "serp_features_prev",
    "serp_target_main_positions_count",
    "serp_target_main_positions_count_prev",
    "serp_target_positions_count",
    "serp_target_positions_count_prev",
    "status",
    "sum_paid_traffic",
    "sum_paid_traffic_merged",
    "sum_paid_traffic_prev",
    "sum_traffic",
    "sum_traffic_merged",
    "sum_traffic_prev",
    "volume",
    "volume_desktop_pct",
    "volume_merged",
    "volume_mobile_pct",
    "volume_prev",
    "words",
    "words_merged",
    "words_prev",
  ],
  ahrefs_top_pages: [
    "ai_responses_chatgpt",
    "ai_responses_copilot",
    "ai_responses_gemini",
    "ai_responses_google_ai_mode",
    "ai_responses_google_ai_overviews",
    "ai_responses_grok",
    "ai_responses_perplexity",
    "keywords",
    "keywords_diff",
    "keywords_diff_percent",
    "keywords_merged",
    "keywords_prev",
    "page_type",
    "raw_url",
    "raw_url_prev",
    "referring_domains",
    "status",
    "sum_traffic",
    "sum_traffic_merged",
    "sum_traffic_prev",
    "top_keyword",
    "top_keyword_best_position",
    "top_keyword_best_position_diff",
    "top_keyword_best_position_kind",
    "top_keyword_best_position_kind_prev",
    "top_keyword_best_position_prev",
    "top_keyword_best_position_title",
    "top_keyword_best_position_title_prev",
    "top_keyword_country",
    "top_keyword_country_prev",
    "top_keyword_prev",
    "top_keyword_volume",
    "top_keyword_volume_prev",
    "traffic_diff",
    "traffic_diff_percent",
    "ur",
    "url",
    "url_prev",
    "value",
    "value_diff",
    "value_diff_percent",
    "value_merged",
    "value_prev",
  ],
  ahrefs_organic_competitors: [
    "competitor_domain",
    "competitor_url",
    "domain_rating",
    "group_mode",
    "keywords_common",
    "keywords_competitor",
    "keywords_target",
    "pages",
    "pages_diff",
    "pages_merged",
    "pages_prev",
    "share",
    "traffic",
    "traffic_diff",
    "traffic_merged",
    "traffic_prev",
    "value",
    "value_diff",
    "value_merged",
    "value_prev",
  ],
  ahrefs_keywords_overview: [
    "clicks",
    "cpc",
    "cps",
    "difficulty",
    "first_seen",
    "global_volume",
    "intents",
    "keyword",
    "parent_topic",
    "parent_volume",
    "searches_pct_clicks_organic_and_paid",
    "searches_pct_clicks_organic_only",
    "searches_pct_clicks_paid_only",
    "serp_features",
    "serp_last_update",
    "traffic_potential",
    "volume",
    "volume_desktop_pct",
    "volume_mobile_pct",
    "volume_monthly",
    "volume_monthly_history",
  ],
  ahrefs_matching_terms: [
    "cpc",
    "cps",
    "difficulty",
    "first_seen",
    "global_volume",
    "intents",
    "keyword",
    "parent_topic",
    "serp_features",
    "serp_last_update",
    "traffic_potential",
    "volume",
    "volume_desktop_pct",
    "volume_mobile_pct",
    "volume_monthly",
  ],
  ahrefs_related_terms: [
    "cpc",
    "cps",
    "difficulty",
    "first_seen",
    "global_volume",
    "intents",
    "keyword",
    "parent_topic",
    "serp_features",
    "serp_last_update",
    "traffic_potential",
    "volume",
    "volume_desktop_pct",
    "volume_mobile_pct",
    "volume_monthly",
  ],
  ahrefs_serp_overview: [
    "ahrefs_rank",
    "backlinks",
    "domain_rating",
    "keywords",
    "page_type",
    "position",
    "refdomains",
    "title",
    "top_keyword",
    "top_keyword_volume",
    "traffic",
    "type",
    "update_date",
    "url",
    "url_rating",
    "value",
  ],
  ahrefs_batch_analysis: [
    "ahrefs_rank",
    "backlinks",
    "backlinks_dofollow",
    "backlinks_internal",
    "backlinks_nofollow",
    "backlinks_redirect",
    "domain_rating",
    "index",
    "ip",
    "linked_domains",
    "linked_domains_dofollow",
    "mode",
    "org_cost",
    "org_keywords",
    "org_keywords_1_3",
    "org_keywords_4_10",
    "org_keywords_11_20",
    "org_keywords_21_50",
    "org_keywords_51_plus",
    "org_traffic",
    "org_traffic_top_by_country",
    "outgoing_links",
    "outgoing_links_dofollow",
    "paid_ads",
    "paid_cost",
    "paid_keywords",
    "paid_traffic",
    "protocol",
    "refdomains",
    "refdomains_dofollow",
    "refdomains_nofollow",
    "refips",
    "refips_subnets",
    "url",
    "url_rating",
  ],
};

describe("ahrefs adapter: static spec conformance", () => {
  beforeEach(() => mockedAxios.mockReset());

  it("is unlisted until checked with a paid key, filed under analytics with its own logo", () => {
    expect(a.unlisted).toBe(true);
    expect(a.slug).toBe("ahrefs");
    expect(a.region).toBe("intl");
    expect(a.category).toBe("analytics");
    expect(a.icon).toBe("ahrefs");
  });

  it("sends the key as a Bearer token from the encrypted authConfig, never as a tool parameter", () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe("BEARER_TOKEN");
    expect(a.connector.authConfig).toEqual({ token: "{{AHREFS_API_KEY}}" });
    expect(a.requiredEnvVars).toEqual(["AHREFS_API_KEY"]);
    const [meta] = describeAdapterEnvVars(a as never);
    expect(meta).toMatchObject({
      name: "AHREFS_API_KEY",
      kind: "credential",
      secret: true,
      required: true,
    });
    for (const t of a.tools)
      expect(JSON.stringify(t.parameters)).not.toMatch(
        /AHREFS_API_KEY|"token"/,
      );
  });

  it("accepts a plain key and refuses one pasted with Bearer or spaces", () => {
    const key = new RegExp(a.envVarMeta.AHREFS_API_KEY.pattern!);
    expect(key.test(FAKE_KEY)).toBe(true);
    for (const bad of ["", `Bearer ${FAKE_KEY}`, `${FAKE_KEY} `, "short"])
      expect(key.test(bad)).toBe(false);
  });

  it("checks the connection on the free limits endpoint and explains the error codes", () => {
    expect(a.connector.healthcheckPath).toBe(
      "/subscription-info/limits-and-usage",
    );
    expect(a.probe).toEqual({ tool: "ahrefs_get_limits_and_usage" });
    for (const status of ["400", "401", "403", "429"])
      expect(a.verifyHints[status]).toBeTruthy();
  });

  it("prefixes every tool with ahrefs_, shares no tool name with another adapter, and is all reads", () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    expect([...mine].sort()).toEqual(Object.keys(DOC).sort());
    for (const name of mine) expect(name).toMatch(/^ahrefs_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools)
        expect(mine.has(t.name)).toBe(false);
    }
    for (const t of a.tools) {
      expect(
        deriveToolAnnotations({
          name: t.name,
          connectorType: "REST",
          endpointMapping: t.endpointMapping,
          annotations: t.annotations,
        }).readOnlyHint,
      ).toBe(true);
    }
    // The one POST is a read: Batch Analysis takes its targets as a JSON body.
    expect(
      a.tools
        .filter((t) => t.endpointMapping.method !== "GET")
        .map((t) => t.name),
    ).toEqual(["ahrefs_batch_analysis"]);
    expect(tool("ahrefs_batch_analysis").annotations).toEqual({
      readOnlyHint: true,
    });
  });

  it.each(Object.keys(DOC))(
    "%s sends only documented parameters and covers the required ones",
    (name) => {
      const doc = DOC[name];
      const t = tool(name);
      const props = t.parameters.properties ?? {};
      const mapped =
        t.endpointMapping.queryParams ?? t.endpointMapping.bodyMapping ?? {};
      expect(t.endpointMapping.path).toBe(doc.path);
      for (const k of Object.keys(mapped)) expect(doc.params).toContain(k);
      for (const value of Object.values(mapped)) {
        if (typeof value === "string" && value.startsWith("$"))
          expect(props).toHaveProperty(value.slice(1));
      }
      for (const req of doc.required) {
        expect(Object.keys(mapped)).toContain(req);
        expect(
          (t.parameters.required ?? []).includes(req) ||
            props[req]?.default !== undefined,
        ).toBe(true);
      }
      if (props.limit) expect(props.limit.default).toBe(10);
      if (props.select) {
        const def = props.select.default;
        for (const c of Array.isArray(def) ? def : String(def).split(","))
          expect(COLUMNS[name]).toContain(c);
      }
      if (props.order_by?.default)
        expect(COLUMNS[name]).toContain(
          String(props.order_by.default).split(":")[0],
        );
      expect(t.description).toMatch(/\bunits?\b/);
    },
  );

  it("only points the model at tools that exist, documents setup, cost and free test queries, and writes no em dashes", () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bahrefs_[a-z_]+/g),
      ...a.tools.flatMap((t) => [
        ...t.description.matchAll(/\bahrefs_[a-z_]+/g),
      ]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain("https://app.ahrefs.com/account/api-keys");
    expect(a.instructions).toContain("max(50, per_row_cost x rows)");
    expect(a.instructions).toMatch(/Free test queries/);
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

  it("carries valid response mappings with a size cap", () => {
    for (const t of a.tools)
      expect(validateTransform(t.responseMapping!.transform)).toBeNull();
    for (const t of a.tools.filter(
      (x) => x.name !== "ahrefs_get_limits_and_usage",
    ))
      expect(t.responseMapping!.transform.maxBytes).toBeGreaterThan(0);
    const rows = { keywords: [{ keyword: "seo", volume: 100 }] };
    const out = shape("ahrefs_keywords_overview", rows);
    expect(out.applied).toBe(true);
    expect(out.value).toEqual(rows);
  });

  it("reduces the limits answer to the plan and the unit counters", () => {
    const usage = {
      subscription: "Advanced",
      usage_reset_date: "2026-11-01T00:00:00Z",
      units_limit_workspace: 2000000,
      units_usage_workspace: 1234,
      units_limit_api_key: 100000,
      units_usage_api_key: 50,
      api_key_expiration_date: "2027-10-14T00:00:00Z",
    };
    expect(
      shape("ahrefs_get_limits_and_usage", { limits_and_usage: usage }).value,
    ).toEqual(usage);
  });

  const table: Array<
    [string, Record<string, unknown>, string, Record<string, unknown>]
  > = [
    [
      "ahrefs_get_limits_and_usage",
      {},
      "/subscription-info/limits-and-usage",
      {},
    ],
    [
      "ahrefs_domain_rating",
      { target: "ahrefs.com", date: "2026-10-14" },
      "/site-explorer/domain-rating",
      { target: "ahrefs.com", date: "2026-10-14" },
    ],
    [
      "ahrefs_backlinks_stats",
      { target: "ahrefs.com", date: "2026-10-14" },
      "/site-explorer/backlinks-stats",
      { target: "ahrefs.com", date: "2026-10-14" },
    ],
    [
      "ahrefs_site_metrics",
      { target: "ahrefs.com", date: "2026-10-14", country: "de" },
      "/site-explorer/metrics",
      { target: "ahrefs.com", date: "2026-10-14", country: "de" },
    ],
    [
      "ahrefs_metrics_history",
      { target: "ahrefs.com", date_from: "2026-01-01" },
      "/site-explorer/metrics-history",
      {
        target: "ahrefs.com",
        date_from: "2026-01-01",
        history_grouping: "monthly",
        select: "date,org_traffic,org_cost",
      },
    ],
    [
      "ahrefs_domain_rating_history",
      { target: "ahrefs.com", date_from: "2026-01-01" },
      "/site-explorer/domain-rating-history",
      {
        target: "ahrefs.com",
        date_from: "2026-01-01",
        history_grouping: "monthly",
      },
    ],
    [
      "ahrefs_backlinks",
      { target: "ahrefs.com" },
      "/site-explorer/all-backlinks",
      {
        target: "ahrefs.com",
        select:
          "url_from,url_to,anchor,title,domain_rating_source,is_dofollow,first_seen,last_seen",
        limit: 10,
        order_by: "domain_rating_source:desc",
      },
    ],
    [
      "ahrefs_referring_domains",
      { target: "ahrefs.com" },
      "/site-explorer/refdomains",
      {
        target: "ahrefs.com",
        select:
          "domain,domain_rating,links_to_target,dofollow_links,first_seen,last_seen",
        limit: 10,
        order_by: "domain_rating:desc",
      },
    ],
    [
      "ahrefs_anchors",
      { target: "ahrefs.com" },
      "/site-explorer/anchors",
      {
        target: "ahrefs.com",
        select:
          "anchor,refdomains,links_to_target,dofollow_links,first_seen,last_seen",
        limit: 10,
        order_by: "refdomains:desc",
      },
    ],
    [
      "ahrefs_organic_keywords",
      { target: "ahrefs.com", date: "2026-10-14" },
      "/site-explorer/organic-keywords",
      {
        target: "ahrefs.com",
        date: "2026-10-14",
        select:
          "keyword,best_position,best_position_url,volume,sum_traffic,keyword_difficulty,cpc",
        limit: 10,
        order_by: "sum_traffic:desc",
      },
    ],
    [
      "ahrefs_top_pages",
      { target: "ahrefs.com", date: "2026-10-14" },
      "/site-explorer/top-pages",
      {
        target: "ahrefs.com",
        date: "2026-10-14",
        select:
          "url,sum_traffic,value,keywords,top_keyword,top_keyword_best_position",
        limit: 10,
        order_by: "sum_traffic:desc",
      },
    ],
    [
      "ahrefs_organic_competitors",
      { target: "ahrefs.com", date: "2026-10-14", country: "us" },
      "/site-explorer/organic-competitors",
      {
        target: "ahrefs.com",
        date: "2026-10-14",
        country: "us",
        select:
          "competitor_domain,keywords_common,keywords_competitor,share,traffic,domain_rating",
        limit: 10,
        order_by: "keywords_common:desc",
      },
    ],
    [
      "ahrefs_keywords_overview",
      { keywords: "ahrefs", country: "us" },
      "/keywords-explorer/overview",
      {
        keywords: "ahrefs",
        country: "us",
        select: "keyword,volume,difficulty,cpc,traffic_potential,parent_topic",
        limit: 10,
        order_by: "volume:desc",
      },
    ],
    [
      "ahrefs_matching_terms",
      { keywords: "ahrefs", country: "us" },
      "/keywords-explorer/matching-terms",
      {
        keywords: "ahrefs",
        country: "us",
        select: "keyword,volume,difficulty,cpc,traffic_potential",
        limit: 10,
        order_by: "volume:desc",
      },
    ],
    [
      "ahrefs_related_terms",
      { keywords: "ahrefs", country: "us" },
      "/keywords-explorer/related-terms",
      {
        keywords: "ahrefs",
        country: "us",
        select: "keyword,volume,difficulty,cpc,traffic_potential",
        limit: 10,
        order_by: "volume:desc",
      },
    ],
    [
      "ahrefs_volume_history",
      { keyword: "ahrefs", country: "us" },
      "/keywords-explorer/volume-history",
      { keyword: "ahrefs", country: "us" },
    ],
    [
      "ahrefs_serp_overview",
      { keyword: "yep", country: "us" },
      "/serp-overview/serp-overview",
      {
        keyword: "yep",
        country: "us",
        select:
          "position,url,title,type,domain_rating,url_rating,backlinks,refdomains,traffic",
        top_positions: 10,
      },
    ],
  ];

  it("lists every GET tool in the URL table", () => {
    expect(table.map(([name]) => name).sort()).toEqual(
      a.tools
        .filter((t) => t.endpointMapping.method === "GET")
        .map((t) => t.name)
        .sort(),
    );
  });

  it.each(table)(
    "%s calls the right URL with the Bearer key and the small defaults",
    async (name, params, path, query) => {
      mockedAxios.mockResolvedValue({ data: {}, headers: {} });
      await call(name, params);
      const req = sent();
      expect(req.method).toBe("GET");
      expect(req.url).toBe(`${BASE}${path}`);
      expect(req.params ?? {}).toEqual(query);
      expect(req.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
      expect(req.headers["User-Agent"]).toBe("AnythingMCP");
    },
  );

  it("posts the Batch Analysis targets and the default fields as JSON", async () => {
    mockedAxios.mockResolvedValue({ data: { targets: [] }, headers: {} });
    const targets = [
      { url: "ahrefs.com", mode: "subdomains", protocol: "both" },
      { url: "yep.com", mode: "domain", protocol: "https" },
    ];
    await call("ahrefs_batch_analysis", { targets, country: "us" });
    const req = sent();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE}/batch-analysis/batch-analysis`);
    expect(req.data).toEqual({
      targets,
      select: [
        "url",
        "domain_rating",
        "backlinks",
        "refdomains",
        "org_keywords",
        "org_traffic",
      ],
      country: "us",
    });
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  it("passes filters and paging through with Ahrefs names", async () => {
    mockedAxios.mockResolvedValue({ data: {}, headers: {} });
    const where = '{"and":[{"field":"volume","is":["gte",100]}]}';
    await call("ahrefs_matching_terms", {
      keywords: "seo,sem",
      country: "de",
      where,
      terms: "questions",
      limit: 25,
      select: "keyword,volume",
    });
    expect(sent().params).toEqual({
      keywords: "seo,sem",
      country: "de",
      where,
      terms: "questions",
      limit: 25,
      select: "keyword,volume",
      order_by: "volume:desc",
    });
  });
});

const live = process.env.RUN_AHREFS_LIVE ? describe : describe.skip;
live("ahrefs adapter: live", () => {
  const realKey = process.env.AHREFS_API_KEY;
  const today = new Date().toISOString().slice(0, 10);
  beforeAll(() =>
    mockedAxios.mockImplementation((cfg: any) =>
      (mockedAxios.__actual as any).request(cfg),
    ),
  );
  afterAll(() => mockedAxios.mockReset());

  it("refuses a wrong key with 401 and a missing one with 403", async () => {
    await expect(call("ahrefs_get_limits_and_usage", {})).rejects.toMatchObject(
      { response: { status: 401, data: ["Error", "Unauthorized"] } },
    );
    await expect(
      call("ahrefs_domain_rating", { target: "ahrefs.com", date: today }),
    ).rejects.toMatchObject({ response: { status: 401 } });
    await expect(
      call(
        "ahrefs_domain_rating",
        { target: "ahrefs.com", date: today },
        {},
        "NONE",
      ),
    ).rejects.toMatchObject({ response: { status: 403 } });
  }, 30000);

  // Only Ahrefs' free requests: the limits endpoint and the documented free
  // test queries (Site Explorer on ahrefs.com, Keywords Explorer and SERP
  // Overview on the keywords ahrefs / yep alone).
  (realKey ? it : it.skip)(
    "runs the free limits endpoint and free test queries and shapes the real answers",
    async () => {
      const env = { AHREFS_API_KEY: realKey! };
      const limits = shape(
        "ahrefs_get_limits_and_usage",
        await call("ahrefs_get_limits_and_usage", {}, env),
      ).value as any;
      expect(limits.subscription).toBeDefined();
      const dr = await call(
        "ahrefs_domain_rating",
        { target: "ahrefs.com", date: today },
        env,
      );
      expect(dr.domain_rating.domain_rating).toBeGreaterThan(0);
      const bl = shape(
        "ahrefs_backlinks",
        await call("ahrefs_backlinks", { target: "ahrefs.com", limit: 3 }, env),
      ).value as any;
      expect(bl.backlinks.length).toBeGreaterThan(0);
      const kw = shape(
        "ahrefs_keywords_overview",
        await call(
          "ahrefs_keywords_overview",
          { keywords: "ahrefs", country: "us" },
          env,
        ),
      ).value as any;
      expect(kw.keywords[0].keyword).toBe("ahrefs");
      const serp = shape(
        "ahrefs_serp_overview",
        await call(
          "ahrefs_serp_overview",
          { keyword: "yep", country: "us", top_positions: 3 },
          env,
        ),
      ).value as any;
      expect(serp.positions.length).toBeGreaterThan(0);
    },
    90000,
  );
});
