import axios from "axios";
import * as adapter from "./semrush.json";
import { RestEngine } from "../../connectors/engines/rest.engine";
import { OAuth2TokenService } from "../../connectors/engines/oauth2-token.service";
import { LoginTokenService } from "../../connectors/engines/login-token.service";
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
 * Two layers of verification for the Semrush adapter:
 *
 *   1. Static: always runs. Pins the key as the `key` query parameter added by
 *      QUERY_AUTH from the encrypted authConfig, every tool's report type and
 *      query parameters through the real RestEngine against the parameter
 *      lists, sortings and columns of developer.semrush.com (SEO API v3,
 *      fetched 14 Oct 2026), the small default display_limit that keeps the
 *      unit cost down, and the pass-through of the CSV answers.
 *
 *   2. Live: skipped unless RUN_SEMRUSH_LIVE=1. Without a key it checks that
 *      Semrush refuses a wrong key on the free units endpoint and on a report
 *      (a refused request spends nothing). With SEMRUSH_API_KEY it reads the
 *      unit balance (free) and runs one keyword overview (10 API units):
 *
 *        RUN_SEMRUSH_LIVE=1 SEMRUSH_API_KEY=... npx jest src/adapters/intl/semrush.live.spec.ts
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
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

const BASE = "https://api.semrush.com";
const UNITS_URL = "https://www.semrush.com/users/countapiunits.html";
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = "f".repeat(32);
const ENV: Record<string, string> = { SEMRUSH_API_KEY: FAKE_KEY };

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
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[0][0];
const shape = (name: string, raw: unknown) =>
  applyResponseTransform(raw, tool(name).responseMapping as any);

// Report type, documented request parameters (besides type and key), the
// documented sortings and export columns, and the API units per line, from
// the SEO API v3 reference.
type Report = {
  type: string;
  path: string;
  params: string[];
  sorts?: string[];
  columns: string[];
  units: number;
};
const SORT_ORGANIC = [
  "po_asc",
  "po_desc",
  "tg_asc",
  "tg_desc",
  "tr_asc",
  "tr_desc",
  "tc_asc",
  "tc_desc",
  "nq_asc",
  "nq_desc",
  "co_asc",
  "co_desc",
  "kd_asc",
  "kd_desc",
  "cp_asc",
  "cp_desc",
  "nr_asc",
  "nr_desc",
  "ts_asc",
  "ts_desc",
];
const SORT_PAID = [
  "po_asc",
  "po_desc",
  "tg_asc",
  "tg_desc",
  "tr_asc",
  "tr_desc",
  "tc_asc",
  "tc_desc",
  "nq_asc",
  "nq_desc",
];
const SORT_IDEAS = [
  "nq_asc",
  "nq_desc",
  "cp_asc",
  "cp_desc",
  "co_asc",
  "co_desc",
  "nr_asc",
  "nr_desc",
  "kd_asc",
  "kd_desc",
];
const KW_COLS = ["Ph", "Nq", "Cp", "Co", "Nr", "Td", "In", "Kd"];
const REPORTS: Record<string, Report> = {
  semrush_domain_overview: {
    type: "domain_rank",
    path: "/",
    units: 10,
    params: [
      "domain",
      "database",
      "export_escape",
      "export_decode",
      "display_date",
      "export_columns",
    ],
    columns: ["Dn", "Rk", "Or", "Xn", "Ot", "Oc", "Ad", "At", "Ac"],
  },
  semrush_domain_overview_all_databases: {
    type: "domain_ranks",
    path: "/",
    units: 10,
    params: [
      "domain",
      "database",
      "display_limit",
      "display_offset",
      "export_escape",
      "display_date",
      "export_columns",
      "display_sort",
    ],
    sorts: [
      "rk_asc",
      "rk_desc",
      "or_asc",
      "or_desc",
      "ot_asc",
      "ot_desc",
      "oc_asc",
      "oc_desc",
      "ad_asc",
      "ad_desc",
      "at_asc",
      "at_desc",
      "ac_asc",
      "ac_desc",
    ],
    columns: [
      "Db",
      "Dt",
      "Dn",
      "Rk",
      "Or",
      "Ot",
      "Oc",
      "Ad",
      "At",
      "Ac",
      "Sh",
      "Sv",
    ],
  },
  semrush_domain_history: {
    type: "domain_rank_history",
    path: "/",
    units: 10,
    params: [
      "domain",
      "database",
      "display_limit",
      "display_offset",
      "export_escape",
      "display_daily",
      "export_columns",
      "display_sort",
    ],
    sorts: ["dt_asc", "dt_desc"],
    columns: ["Rk", "Or", "Xn", "Ot", "Oc", "Ad", "At", "Ac", "Dt"],
  },
  semrush_domain_organic_keywords: {
    type: "domain_organic",
    path: "/",
    units: 10,
    params: [
      "domain",
      "database",
      "display_limit",
      "display_offset",
      "export_escape",
      "display_date",
      "display_daily",
      "export_columns",
      "display_sort",
      "display_positions",
      "display_filter",
      "display_positions_type",
    ],
    sorts: SORT_ORGANIC,
    columns: [
      "Ph",
      "Po",
      "Pp",
      "Pd",
      "Nq",
      "Cp",
      "Ur",
      "Tr",
      "Tg",
      "Tc",
      "Co",
      "Nr",
      "Td",
      "Kd",
      "Fp",
      "Fk",
      "Ts",
      "In",
      "Pt",
    ],
  },
  semrush_domain_paid_keywords: {
    type: "domain_adwords",
    path: "/",
    units: 20,
    params: [
      "domain",
      "database",
      "display_limit",
      "display_offset",
      "export_escape",
      "export_decode",
      "display_date",
      "export_columns",
      "display_sort",
      "display_positions",
      "display_filter",
    ],
    sorts: SORT_PAID,
    columns: [
      "Ph",
      "Po",
      "Pp",
      "Pd",
      "Ab",
      "Nq",
      "Cp",
      "Tg",
      "Tr",
      "Tc",
      "Co",
      "Nr",
      "Td",
      "Tt",
      "Ds",
      "Vu",
      "Ur",
      "Ts",
      "Un",
    ],
  },
  semrush_domain_organic_competitors: {
    type: "domain_organic_organic",
    path: "/",
    units: 40,
    params: [
      "domain",
      "database",
      "display_limit",
      "display_offset",
      "export_escape",
      "export_decode",
      "display_date",
      "export_columns",
      "display_sort",
    ],
    sorts: ["np_desc", "np_asc", "cr_desc", "cr_asc"],
    columns: ["Dn", "Cr", "Np", "Or", "Ot", "Oc", "Ad", "Sr", "St", "Sc"],
  },
  semrush_domain_organic_pages: {
    type: "domain_organic_unique",
    path: "/",
    units: 10,
    params: [
      "domain",
      "database",
      "display_limit",
      "display_offset",
      "export_escape",
      "export_decode",
      "display_date",
      "export_columns",
      "display_sort",
      "display_filter",
    ],
    sorts: [
      "pc_asc",
      "pc_desc",
      "tg_asc",
      "tg_desc",
      "tr_asc",
      "tr_desc",
      "sr_asc",
      "sr_desc",
      "st_asc",
      "st_desc",
    ],
    columns: ["Ur", "Pc", "Tg", "Tr"],
  },
  semrush_keyword_gap: {
    type: "domain_domains",
    path: "/",
    units: 80,
    params: [
      "domains",
      "database",
      "display_limit",
      "display_offset",
      "export_escape",
      "export_decode",
      "display_date",
      "export_columns",
      "display_sort",
      "display_filter",
    ],
    sorts: [
      "p0_asc",
      "p0_desc",
      "p1_asc",
      "p1_desc",
      "p2_asc",
      "p2_desc",
      "p3_asc",
      "p3_desc",
      "p4_asc",
      "p4_desc",
      "nq_asc",
      "nq_desc",
      "co_asc",
      "co_desc",
      "cp_asc",
      "cp_desc",
      "nr_asc",
      "nr_desc",
    ],
    columns: [
      "Ph",
      "P0",
      "P1",
      "P2",
      "P3",
      "P4",
      "Nr",
      "Cp",
      "Nq",
      "Kd",
      "Co",
      "Td",
    ],
  },
  semrush_keyword_overview: {
    type: "phrase_this",
    path: "/",
    units: 10,
    params: [
      "phrase",
      "database",
      "export_escape",
      "export_decode",
      "display_date",
      "export_columns",
    ],
    columns: KW_COLS,
  },
  semrush_keyword_overview_all_databases: {
    type: "phrase_all",
    path: "/",
    units: 10,
    params: [
      "phrase",
      "database",
      "export_escape",
      "export_decode",
      "export_columns",
    ],
    columns: ["Dt", "Db", "Ph", "Nq", "Cp", "Co", "Nr", "In", "Kd"],
  },
  semrush_batch_keyword_overview: {
    type: "phrase_these",
    path: "/",
    units: 10,
    params: [
      "phrase",
      "database",
      "export_escape",
      "export_decode",
      "display_date",
      "export_columns",
    ],
    columns: KW_COLS,
  },
  semrush_keyword_organic_results: {
    type: "phrase_organic",
    path: "/",
    units: 10,
    params: [
      "phrase",
      "database",
      "display_limit",
      "display_offset",
      "export_escape",
      "export_decode",
      "display_date",
      "export_columns",
      "positions_type",
    ],
    columns: ["Po", "Pt", "Dn", "Ur", "Fk", "Fp", "Fl"],
  },
  semrush_related_keywords: {
    type: "phrase_related",
    path: "/",
    units: 40,
    params: [
      "phrase",
      "database",
      "display_limit",
      "display_offset",
      "export_escape",
      "export_decode",
      "export_columns",
      "display_sort",
      "display_filter",
    ],
    sorts: [...SORT_IDEAS, "rr_asc", "rr_desc"],
    columns: ["Ph", "Nq", "Cp", "Co", "Nr", "Td", "Rr", "Fk", "In", "Kd"],
  },
  semrush_broad_match_keywords: {
    type: "phrase_fullsearch",
    path: "/",
    units: 20,
    params: [
      "phrase",
      "database",
      "display_limit",
      "display_offset",
      "export_escape",
      "export_decode",
      "export_columns",
      "display_sort",
      "display_filter",
    ],
    sorts: SORT_IDEAS,
    columns: ["Ph", "Nq", "Cp", "Co", "Nr", "Td", "Fk", "In", "Kd"],
  },
  semrush_keyword_questions: {
    type: "phrase_questions",
    path: "/",
    units: 40,
    params: [
      "phrase",
      "database",
      "display_limit",
      "display_offset",
      "export_escape",
      "export_decode",
      "export_columns",
      "display_sort",
      "display_filter",
    ],
    sorts: SORT_IDEAS,
    columns: KW_COLS,
  },
  semrush_keyword_difficulty: {
    type: "phrase_kdi",
    path: "/",
    units: 50,
    params: ["phrase", "database", "export_escape", "export_columns"],
    columns: ["Ph", "Kd"],
  },
  semrush_url_organic_keywords: {
    type: "url_organic",
    path: "/",
    units: 10,
    params: [
      "url",
      "database",
      "display_limit",
      "display_offset",
      "export_escape",
      "export_decode",
      "display_date",
      "export_columns",
      "display_sort",
      "display_filter",
      "display_positions_type",
    ],
    sorts: SORT_PAID,
    columns: [
      "Ph",
      "Po",
      "Pp",
      "Nq",
      "Cp",
      "Co",
      "Kd",
      "Tr",
      "Tg",
      "Tc",
      "Nr",
      "Td",
      "Fp",
      "Fk",
      "Ts",
      "In",
      "Pt",
    ],
  },
  semrush_backlinks_overview: {
    type: "backlinks_overview",
    path: "/analytics/v1/",
    units: 40,
    params: ["target", "target_type", "export_columns"],
    columns: [
      "ascore",
      "total",
      "domains_num",
      "urls_num",
      "ips_num",
      "ipclassc_num",
      "follows_num",
      "nofollows_num",
      "sponsored_num",
      "ugc_num",
      "texts_num",
      "images_num",
      "forms_num",
      "frames_num",
    ],
  },
  semrush_backlinks: {
    type: "backlinks",
    path: "/analytics/v1/",
    units: 40,
    params: [
      "target",
      "target_type",
      "export_columns",
      "display_sort",
      "display_limit",
      "display_offset",
      "display_filter",
    ],
    sorts: [
      "page_ascore_asc",
      "page_ascore_desc",
      "last_seen_asc",
      "last_seen_desc",
      "first_seen_asc",
      "first_seen_desc",
    ],
    columns: [
      "page_ascore",
      "response_code",
      "source_size",
      "external_num",
      "internal_num",
      "redirect_url",
      "source_url",
      "source_title",
      "image_url",
      "target_url",
      "target_title",
      "anchor",
      "image_alt",
      "last_seen",
      "first_seen",
      "nofollow",
      "form",
      "frame",
      "image",
      "sitewide",
      "newlink",
      "lostlink",
    ],
  },
  semrush_referring_domains: {
    type: "backlinks_refdomains",
    path: "/analytics/v1/",
    units: 40,
    params: [
      "target",
      "target_type",
      "export_columns",
      "display_sort",
      "display_limit",
      "display_offset",
      "display_filter",
    ],
    sorts: [
      "domain_ascore_asc",
      "domain_ascore_desc",
      "backlinks_num_asc",
      "backlinks_num_desc",
      "last_seen_asc",
      "last_seen_desc",
      "first_seen_asc",
      "first_seen_desc",
    ],
    columns: [
      "domain_ascore",
      "domain_score",
      "domain",
      "backlinks_num",
      "domain_trust_score",
      "ip",
      "country",
      "first_seen",
      "last_seen",
    ],
  },
};
const REPORT_TOOLS = Object.keys(REPORTS);

describe("semrush adapter: static spec conformance", () => {
  beforeEach(() => mockedAxios.mockReset());

  it("is listed: checked against vendor SDKs, specs and working clients on 14 Oct 2026, filed under analytics with its own logo", () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe("semrush");
    expect(a.region).toBe("intl");
    expect(a.category).toBe("analytics");
    expect(a.icon).toBe("semrush");
  });

  it("sends the key as the key query parameter from the encrypted authConfig, never as a literal", () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe("QUERY_AUTH");
    expect(a.connector.authConfig).toEqual({ key: "{{SEMRUSH_API_KEY}}" });
    expect(a.requiredEnvVars).toEqual(["SEMRUSH_API_KEY"]);
    const [meta] = describeAdapterEnvVars(a as never);
    expect(meta).toMatchObject({
      name: "SEMRUSH_API_KEY",
      kind: "credential",
      secret: true,
      required: true,
    });
    expect(findSecretInQueryParam("key", "{{SEMRUSH_API_KEY}}")).toEqual([]);
    for (const t of a.tools) {
      expect(Object.keys(t.endpointMapping.queryParams ?? {})).not.toContain(
        "key",
      );
      expect(Object.keys(t.parameters.properties ?? {})).not.toContain("key");
    }
  });

  // Semrush's own key check (countapiunits, 14 Oct 2026) refuses upper case,
  // non-hex letters and any length but 32.
  it("accepts a 32-character lower-case hex key and refuses everything Semrush calls invalid", () => {
    const key = new RegExp(a.envVarMeta.SEMRUSH_API_KEY.pattern!);
    expect(key.test(FAKE_KEY)).toBe(true);
    for (const bad of [
      "",
      `key=${FAKE_KEY}`,
      `${FAKE_KEY} `,
      "short",
      "F".repeat(32),
      "g".repeat(32),
      "f".repeat(34),
    ])
      expect(key.test(bad)).toBe(false);
  });

  it("checks the connection on the free unit balance and explains the error codes", () => {
    expect(a.connector.healthcheckPath).toBe(UNITS_URL);
    expect(a.probe).toEqual({ tool: "semrush_get_api_units" });
    expect(tool("semrush_get_api_units").endpointMapping.path).toBe(UNITS_URL);
    for (const status of ["400", "401", "403", "429"])
      expect(a.verifyHints[status]).toBeTruthy();
  });

  it("prefixes every tool with semrush_, shares no tool name with another adapter, and is all reads", () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    expect([...mine].sort()).toEqual(
      ["semrush_get_api_units", ...REPORT_TOOLS].sort(),
    );
    for (const name of mine) expect(name).toMatch(/^semrush_[a-z_]+$/);
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

  it.each(REPORT_TOOLS)(
    "%s sends only documented parameters, small defaults and its unit price",
    (name) => {
      const r = REPORTS[name];
      const t = tool(name);
      const qp = t.endpointMapping.queryParams!;
      const props = t.parameters.properties ?? {};
      expect(t.endpointMapping.path).toBe(r.path);
      expect(qp.type).toBe(r.type);
      for (const k of Object.keys(qp))
        if (k !== "type") expect(r.params).toContain(k);
      for (const value of Object.values(qp)) {
        if (typeof value === "string" && value.startsWith("$"))
          expect(props).toHaveProperty(value.slice(1));
      }
      for (const req of t.parameters.required ?? [])
        expect(props).toHaveProperty(req);
      if (r.params.includes("display_limit")) {
        expect(qp.display_limit).toBe("$display_limit");
        expect(props.display_limit.default).toBe(10);
      }
      if (props.display_sort) {
        for (const v of props.display_sort.enum ?? [])
          expect(r.sorts).toContain(v);
        expect(r.sorts).toContain(props.display_sort.default);
      }
      for (const c of String(props.export_columns.default).split(","))
        expect(r.columns).toContain(c);
      expect(t.description).toMatch(new RegExp(`${r.units} API units`));
      expect(t.description).toMatch(/semicolon-separated CSV/);
    },
  );

  it("only points the model at tools that exist, documents setup, cost and the CSV format, and writes no em dashes", () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bsemrush_[a-z_]+/g),
      ...a.tools.flatMap((t) => [
        ...t.description.matchAll(/\bsemrush_[a-z_]+/g),
      ]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain(
      "https://www.semrush.com/accounts/api-keys/active",
    );
    expect(a.instructions).toMatch(/spends API units/);
    expect(a.instructions).toMatch(/separated by semicolons/);
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

  it("carries valid response mappings that pass the CSV through and cap a runaway answer", () => {
    for (const name of REPORT_TOOLS) {
      const rm = tool(name).responseMapping!;
      expect(validateTransform(rm.transform)).toBeNull();
      expect(rm.transform.maxBytes).toBeGreaterThan(0);
    }
    const csv =
      "Keyword;Search Volume;CPC;Competition;Number of Results\r\nseo;110000;14.82;0.5;678000000\r\n";
    const small = shape("semrush_keyword_overview", csv);
    expect(small.applied).toBe(true);
    expect(small.value).toBe(csv);
    const big = shape(
      "semrush_domain_organic_keywords",
      "Keyword;Position\r\n" + "x;1\r\n".repeat(30000),
    );
    expect(big.truncated).toBe(true);
    expect((big.value as any)._truncated).toBe(true);
  });

  it("reads the unit balance from www.semrush.com with the key", async () => {
    mockedAxios.mockResolvedValue({ data: 1000, headers: {} });
    expect(await call("semrush_get_api_units", {})).toBe(1000);
    expect(sent().url).toBe(UNITS_URL);
    expect(sent().params).toEqual({ key: FAKE_KEY });
  });

  const table: Array<
    [string, Record<string, unknown>, string, Record<string, unknown>]
  > = [
    [
      "semrush_domain_overview",
      { domain: "example.com", database: "us" },
      "/",
      {
        type: "domain_rank",
        domain: "example.com",
        database: "us",
        export_columns: "Dn,Rk,Or,Ot,Oc,Ad,At,Ac",
      },
    ],
    [
      "semrush_domain_overview_all_databases",
      { domain: "example.com" },
      "/",
      {
        type: "domain_ranks",
        domain: "example.com",
        display_limit: 10,
        display_sort: "ot_desc",
        export_columns: "Db,Dn,Rk,Or,Ot,Oc,Ad,At,Ac",
      },
    ],
    [
      "semrush_domain_history",
      { domain: "example.com", database: "de" },
      "/",
      {
        type: "domain_rank_history",
        domain: "example.com",
        database: "de",
        display_limit: 10,
        display_sort: "dt_desc",
        export_columns: "Dt,Rk,Or,Ot,Oc,Ad,At,Ac",
      },
    ],
    [
      "semrush_domain_organic_keywords",
      { domain: "example.com", database: "us" },
      "/",
      {
        type: "domain_organic",
        domain: "example.com",
        database: "us",
        display_limit: 10,
        display_sort: "tr_desc",
        export_columns: "Ph,Po,Pp,Nq,Cp,Ur,Tr,Kd,In",
      },
    ],
    [
      "semrush_domain_paid_keywords",
      { domain: "example.com", database: "us" },
      "/",
      {
        type: "domain_adwords",
        domain: "example.com",
        database: "us",
        display_limit: 10,
        display_sort: "tr_desc",
        export_columns: "Ph,Po,Nq,Cp,Vu,Ur,Tr,Tt,Ds",
      },
    ],
    [
      "semrush_domain_organic_competitors",
      { domain: "example.com", database: "us" },
      "/",
      {
        type: "domain_organic_organic",
        domain: "example.com",
        database: "us",
        display_limit: 10,
        display_sort: "cr_desc",
        export_columns: "Dn,Cr,Np,Or,Ot,Oc,Ad",
      },
    ],
    [
      "semrush_domain_organic_pages",
      { domain: "example.com", database: "us" },
      "/",
      {
        type: "domain_organic_unique",
        domain: "example.com",
        database: "us",
        display_limit: 10,
        display_sort: "tr_desc",
        export_columns: "Ur,Pc,Tg,Tr",
      },
    ],
    [
      "semrush_keyword_gap",
      { domains: "*|or|a.com|-|or|b.com", database: "us" },
      "/",
      {
        type: "domain_domains",
        domains: "*|or|a.com|-|or|b.com",
        database: "us",
        display_limit: 10,
        display_sort: "nq_desc",
        export_columns: "Ph,P0,P1,Nq,Cp,Kd",
      },
    ],
    [
      "semrush_keyword_overview",
      { phrase: "seo", database: "us" },
      "/",
      {
        type: "phrase_this",
        phrase: "seo",
        database: "us",
        export_columns: "Ph,Nq,Cp,Co,Nr,Td,In,Kd",
      },
    ],
    [
      "semrush_keyword_overview_all_databases",
      { phrase: "seo" },
      "/",
      { type: "phrase_all", phrase: "seo", export_columns: "Db,Ph,Nq,Cp,Co" },
    ],
    [
      "semrush_batch_keyword_overview",
      { phrase: "seo;sem", database: "us" },
      "/",
      {
        type: "phrase_these",
        phrase: "seo;sem",
        database: "us",
        export_columns: "Ph,Nq,Cp,Co,Nr,In,Kd",
      },
    ],
    [
      "semrush_keyword_organic_results",
      { phrase: "seo", database: "us" },
      "/",
      {
        type: "phrase_organic",
        phrase: "seo",
        database: "us",
        display_limit: 10,
        export_columns: "Po,Dn,Ur,Fp",
      },
    ],
    [
      "semrush_related_keywords",
      { phrase: "seo", database: "us" },
      "/",
      {
        type: "phrase_related",
        phrase: "seo",
        database: "us",
        display_limit: 10,
        display_sort: "nq_desc",
        export_columns: "Ph,Nq,Cp,Co,Kd,In,Rr",
      },
    ],
    [
      "semrush_broad_match_keywords",
      { phrase: "seo", database: "us" },
      "/",
      {
        type: "phrase_fullsearch",
        phrase: "seo",
        database: "us",
        display_limit: 10,
        display_sort: "nq_desc",
        export_columns: "Ph,Nq,Cp,Co,Kd,In",
      },
    ],
    [
      "semrush_keyword_questions",
      { phrase: "seo", database: "us" },
      "/",
      {
        type: "phrase_questions",
        phrase: "seo",
        database: "us",
        display_limit: 10,
        display_sort: "nq_desc",
        export_columns: "Ph,Nq,Cp,Co,Kd,In",
      },
    ],
    [
      "semrush_keyword_difficulty",
      { phrase: "ebay;seo", database: "us" },
      "/",
      {
        type: "phrase_kdi",
        phrase: "ebay;seo",
        database: "us",
        export_columns: "Ph,Kd",
      },
    ],
    [
      "semrush_url_organic_keywords",
      { url: "https://example.com/", database: "us" },
      "/",
      {
        type: "url_organic",
        url: "https://example.com/",
        database: "us",
        display_limit: 10,
        display_sort: "tr_desc",
        export_columns: "Ph,Po,Nq,Cp,Kd,Tr,In",
      },
    ],
    [
      "semrush_backlinks_overview",
      { target: "example.com" },
      "/analytics/v1/",
      {
        type: "backlinks_overview",
        target: "example.com",
        target_type: "root_domain",
        export_columns:
          "ascore,total,domains_num,urls_num,ips_num,follows_num,nofollows_num,texts_num,images_num",
      },
    ],
    [
      "semrush_backlinks",
      { target: "example.com" },
      "/analytics/v1/",
      {
        type: "backlinks",
        target: "example.com",
        target_type: "root_domain",
        display_limit: 10,
        display_sort: "page_ascore_desc",
        export_columns:
          "page_ascore,source_title,source_url,target_url,anchor,nofollow,first_seen,last_seen",
      },
    ],
    [
      "semrush_referring_domains",
      { target: "example.com" },
      "/analytics/v1/",
      {
        type: "backlinks_refdomains",
        target: "example.com",
        target_type: "root_domain",
        display_limit: 10,
        display_sort: "backlinks_num_desc",
        export_columns:
          "domain_ascore,domain,backlinks_num,country,first_seen,last_seen",
      },
    ],
  ];

  it("lists every report tool in the URL table", () => {
    expect(table.map(([name]) => name).sort()).toEqual(
      [...REPORT_TOOLS].sort(),
    );
  });

  it.each(table)(
    "%s calls the right URL with the key and the small defaults",
    async (name, params, path, query) => {
      mockedAxios.mockResolvedValue({
        data: "Keyword;Search Volume\r\n",
        headers: { "content-type": "text/plain" },
      });
      await call(name, params);
      const req = sent();
      expect(req.method).toBe("GET");
      expect(req.url).toBe(`${BASE}${path}`);
      expect(req.params).toEqual({ key: FAKE_KEY, ...query });
      expect(req.headers["User-Agent"]).toBe("AnythingMCP");
    },
  );

  it("passes filters, dates and paging through with Semrush names", async () => {
    mockedAxios.mockResolvedValue({ data: "", headers: {} });
    await call("semrush_domain_organic_keywords", {
      domain: "example.com",
      database: "it",
      display_limit: 20,
      display_offset: 10,
      display_filter: "+|Nq|Gt|1000",
      display_positions: "new",
      display_date: "20260815",
    });
    expect(sent().params).toEqual({
      key: FAKE_KEY,
      type: "domain_organic",
      domain: "example.com",
      database: "it",
      display_limit: 20,
      display_offset: 10,
      display_sort: "tr_desc",
      display_filter: "+|Nq|Gt|1000",
      display_positions: "new",
      export_columns: "Ph,Po,Pp,Nq,Cp,Ur,Tr,Kd,In",
      display_date: "20260815",
    });
  });
});

const live = process.env.RUN_SEMRUSH_LIVE ? describe : describe.skip;
live("semrush adapter: live", () => {
  const realKey = process.env.SEMRUSH_API_KEY;
  beforeAll(() =>
    mockedAxios.mockImplementation((cfg: any) =>
      (mockedAxios.__actual as any).request(cfg),
    ),
  );
  afterAll(() => mockedAxios.mockReset());

  // Refused requests spend nothing, so these run without a Semrush account.
  it("refuses a malformed key with 400 on the free unit balance, but reads 0 units for an unknown well-formed one", async () => {
    await expect(
      call(
        "semrush_get_api_units",
        {},
        { SEMRUSH_API_KEY: "not-a-semrush-key" },
      ),
    ).rejects.toMatchObject({
      response: {
        status: 400,
        data: { errors: [expect.objectContaining({ field: "key" })] },
      },
    });
    // The quirk the tool description warns about: no error, just zero.
    expect(Number(await call("semrush_get_api_units", {}))).toBe(0);
  }, 30000);

  // Semrush answers an unknown key with ERROR 120 (403), ERROR 132 (zero units,
  // on the backlinks API) or, when the key
  // fails its own format check, ERROR 122 (400): never with data.
  it("refuses an unknown key on the analytics and backlinks reports with a 4xx ERROR line", async () => {
    for (const [name, params] of [
      ["semrush_keyword_overview", { phrase: "seo", database: "us" }],
      ["semrush_backlinks_overview", { target: "example.com" }],
    ] as const) {
      const err = await call(name, params).then(
        () => null,
        (e: any) => e,
      );
      expect(err).not.toBeNull();
      expect([400, 403]).toContain(err.response.status);
      expect(err.response.data).toMatch(/^ERROR 1(20|22|32) :: /);
    }
  }, 30000);

  (realKey ? it : it.skip)(
    "reads the balance (free) and one keyword overview (10 API units) as CSV",
    async () => {
      const env = { SEMRUSH_API_KEY: realKey! };
      const units = await call("semrush_get_api_units", {}, env);
      expect(Number(String(units).replace(/\D/g, ""))).toBeGreaterThanOrEqual(
        0,
      );
      const raw = await call(
        "semrush_keyword_overview",
        { phrase: "seo", database: "us", export_columns: "Ph,Nq" },
        env,
      );
      const out = shape("semrush_keyword_overview", raw).value as string;
      expect(out.split(/\r?\n/)[0]).toBe("Keyword;Search Volume");
    },
    60000,
  );
});
