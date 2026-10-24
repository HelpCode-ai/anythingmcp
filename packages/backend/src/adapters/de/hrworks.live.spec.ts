import * as adapter from "./hrworks.json";
import { RestEngine } from "../../connectors/engines/rest.engine";
import { OAuth2TokenService } from "../../connectors/engines/oauth2-token.service";
import { LoginTokenService } from "../../connectors/engines/login-token.service";

/**
 * Smoke test against the real HR WORKS sandbox endpoint to verify that:
 *  - the adapter's baseUrl resolves
 *  - the RestEngine builds a request that HR WORKS accepts as syntactically valid
 *  - Bearer token injection actually puts the token in the Authorization header
 *    (we can tell because the API rejects a bogus token with 401 InvalidBearerTokenError
 *    instead of 403 MissingAuthorizationHeaderError)
 *
 * Skipped automatically in CI (no network); run locally with:
 *   RUN_HRWORKS_LIVE=1 npx jest src/adapters/de/hrworks.live.spec.ts
 */
type Tool = {
  name: string;
  parameters: { required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    bodyMapping?: Record<string, string>;
    queryParams?: Record<string, string>;
  };
};
const tools = (adapter as unknown as { tools: Tool[] }).tools;
const tool = (name: string) => tools.find((t) => t.name === name) as Tool;

// Checked on 13 Oct 2026 with read-only calls against a live tenant: every
// GET below answered 200 with the path and parameters given here.
describe("hrworks adapter — static spec conformance", () => {
  it("prefixes every tool with hrworks_", () => {
    for (const t of tools) expect(t.name).toMatch(/^hrworks_/);
  });

  it.each([
    ["hrworks_list_time_accounts", "/v2/working-times/time-accounts"],
    ["hrworks_list_leave_accounts", "/v2/absences/leave-accounts"],
    [
      "hrworks_get_available_working_hours",
      "/v2/persons/available-working-hours",
    ],
    ["hrworks_get_absences_accumulated", "/v2/absences/accumulated-values"],
    [
      "hrworks_get_sick_leaves_accumulated",
      "/v2/sick-leaves/accumulated-values",
    ],
    [
      "hrworks_get_remote_work_accumulated",
      "/v2/remote-work/accumulated-values",
    ],
    [
      "hrworks_get_person_master_data",
      "/v2/persons/{personIdentifier}/master-data",
    ],
    [
      "hrworks_list_personnel_file_entries",
      "/v2/persons/{personIdentifier}/personnel-file",
    ],
    ["hrworks_list_person_wage_payments", "/v3/persons/{uuid}/wage-payments"],
    ["hrworks_list_wage_payments", "/v3/wage-and-salary/wage-payments"],
    ["hrworks_get_working_times_job", "/v2/working-times/jobs/{jobId}"],
  ])("%s reads GET %s", (name, path) => {
    expect(tool(name).endpointMapping).toMatchObject({ method: "GET", path });
  });

  it("requires the date interval the expense report API insists on", () => {
    expect(
      tool("hrworks_list_travel_expense_reports").parameters.required,
    ).toEqual(["beginDate", "endDate"]);
  });

  it("creates and edits working times with a data array", () => {
    for (const [name, method] of [
      ["hrworks_create_working_times", "POST"],
      ["hrworks_update_working_times", "PUT"],
    ]) {
      expect(tool(name).endpointMapping).toMatchObject({
        method,
        path: "/v2/working-times",
        bodyMapping: {
          data: "$data",
          deleteOverlappingWorkingTimes: "$deleteOverlappingWorkingTimes",
        },
      });
      expect(tool(name).parameters.required).toEqual(["data"]);
    }
  });

  // Paths and parameters from the HR WORKS API v2 reference
  // (developers.hrworks.de: Working Time Status, Onboarding, DELETE Working Times).
  it("reads the clock status and the onboarding documents", () => {
    expect(tool("hrworks_get_working_time_status").endpointMapping).toMatchObject({
      method: "GET",
      path: "/v2/persons/{personIdentifier}/working-times/status",
      queryParams: { personIdentifierType: "$personIdentifierType" },
    });
    expect(tool("hrworks_get_working_time_status").parameters.required).toEqual(["personIdentifier"]);
    expect(tool("hrworks_list_onboarding_documents").endpointMapping).toMatchObject({
      method: "GET",
      path: "/v2/persons/onboarding",
      queryParams: { statusFilter: "$statusFilter", organizationUnits: "$organizationUnits" },
    });
    expect(tool("hrworks_get_onboarding_document").endpointMapping).toMatchObject({
      method: "GET",
      path: "/v2/persons/onboarding/{id}",
    });
    expect(tool("hrworks_get_onboarding_document").parameters.required).toEqual(["id"]);
  });

  it("deletes working times by number, installed switched off", () => {
    const t = tool("hrworks_delete_working_times") as Tool & {
      enabled?: boolean;
      annotations?: Record<string, boolean>;
    };
    expect(t.enabled).toBe(false);
    expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(t.endpointMapping).toMatchObject({
      method: "DELETE",
      path: "/v2/working-times",
      queryParams: { numbers: "$numbers" },
    });
    expect(t.parameters.required).toEqual(["numbers"]);
  });

  it("has no tool for /v3/working-times/{uuid}, which HR WORKS does not serve", () => {
    expect(
      tools.some((t) => t.endpointMapping.path.startsWith("/v3/working-times")),
    ).toBe(false);
  });
});

const maybe = process.env.RUN_HRWORKS_LIVE ? describe : describe.skip;

maybe("hrworks adapter — live smoke test", () => {
  // Minimal stub — we don't exercise OAuth2 paths in this test
  const oauth = {} as unknown as OAuth2TokenService;
  const login = {} as unknown as LoginTokenService;
  const engine = new RestEngine(oauth, login);

  it("reaches HR WORKS auth endpoint and gets InvalidCredentials with bogus creds", async () => {
    const cfg = adapter as unknown as {
      connector: { baseUrl: string; authType: string };
    };

    let err: any;
    try {
      // POST /v2/authentication with bogus credentials — the adapter's auth
      // endpoint returns 403 InvalidCredentialsError for unknown keys.
      await engine.execute(
        { baseUrl: cfg.connector.baseUrl, authType: "NONE" },
        {
          method: "POST",
          path: "/v2/authentication",
          bodyMapping: {
            accessKey: "$accessKey",
            secretAccessKey: "$secretAccessKey",
          },
        },
        {
          accessKey: "bogus-key-for-test",
          secretAccessKey: "bogus-secret-for-test",
        },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.response?.status).toBe(403);
    expect(err.response?.data?.type).toBe("InvalidCredentialsError");
  }, 30000);

  it("Bearer token header is actually injected (bogus token → InvalidBearerTokenError, not MissingAuthorizationHeader)", async () => {
    const cfg = adapter as unknown as {
      connector: { baseUrl: string; authType: string };
      tools: Array<{ name: string; endpointMapping: any }>;
    };
    const orgUnits = cfg.tools.find(
      (t) => t.name === "hrworks_list_organization_units",
    );
    expect(orgUnits).toBeDefined();

    let err: any;
    try {
      await engine.execute(
        {
          baseUrl: cfg.connector.baseUrl,
          authType: "BEARER_TOKEN",
          authConfig: { token: "eyJobviously.not.a.valid.jwt" },
        },
        orgUnits!.endpointMapping,
        {},
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    // HR WORKS returns 403 InvalidBearerTokenError when the header was present but
    // the token is bogus; 403 MissingAuthorizationHeaderError would mean the engine
    // forgot to send the Authorization header at all.
    expect(err.response?.status).toBe(403);
    expect(err.response?.data?.type).toBe("InvalidBearerTokenError");
  }, 30000);
});
