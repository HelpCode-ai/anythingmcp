/**
 * Opt-in live tests using a disposable Sentry project.
 *
 * Required environment variables:
 * SENTRY_AUTH_TOKEN — personal token with org:read and event:read
 * SENTRY_TEST_ORG — organization ID or slug
 * SENTRY_TEST_PROJECT_ID — project containing the test issue
 * SENTRY_TEST_ISSUE_ID — unresolved issue in that project
 * SENTRY_TEST_EVENT_ID — exception event with a stack trace in that issue
 *
 * Use a small test project: list assertions inspect only the first page.
 * The event must be among the first ten events returned for the issue.
 *
 * From the repository root:
 * RUN_SENTRY_LIVE=1 npm test --workspace=packages/backend -- --runInBand --watch=false adapters/intl/sentry.live.spec.ts
 *
 * These tests only read existing data; they do not create test fixtures.
 */

import { AxiosError } from "axios";
import * as adapter from "./sentry.json";
import { RestEngine } from "../../connectors/engines/rest.engine";
import { OAuth2TokenService } from "../../connectors/engines/oauth2-token.service";
import { LoginTokenService } from "../../connectors/engines/login-token.service";

// Normal test runs skip requests to Sentry.
const describeLive =
  process.env.RUN_SENTRY_LIVE === "1" ? describe : describe.skip;

describeLive("Sentry adapter — live API", () => {
  const engine = new RestEngine(
    {} as OAuth2TokenService,
    {} as LoginTokenService,
  );

  beforeAll(() => {
    for (const name of [
      "SENTRY_AUTH_TOKEN",
      "SENTRY_TEST_ORG",
      "SENTRY_TEST_PROJECT_ID",
      "SENTRY_TEST_ISSUE_ID",
      "SENTRY_TEST_EVENT_ID",
    ]) {
      if (!process.env[name]?.trim()) {
        throw new Error(`Set ${name} before running Sentry live tests`);
      }
    }
  });

  async function callTool(
    name: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const tool = adapter.tools.find((item) => item.name === name);
    if (!tool) throw new Error(`Missing adapter tool: ${name}`);

    try {
      return await engine.execute(
        {
          ...adapter.connector,
          authConfig: { token: process.env.SENTRY_AUTH_TOKEN },
        },
        tool.endpointMapping,
        params,
      );
    } catch (error) {
      // Axios errors contain request headers, including the real token.
      const status =
        error instanceof AxiosError ? error.response?.status : undefined;
      throw new Error(
        `${name} failed: ${status ? `HTTP ${status}` : "request error"}`,
      );
    }
  }

  it("finds the configured test project", async () => {
    const result = await callTool("sentry_list_projects", {
      organization_id_or_slug: process.env.SENTRY_TEST_ORG,
      per_page: 100,
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: process.env.SENTRY_TEST_PROJECT_ID,
        }),
      ]),
    );
  }, 60000);

  it("finds the configured issue within its project", async () => {
    const result = await callTool("sentry_list_issues", {
      organization_id_or_slug: process.env.SENTRY_TEST_ORG,
      project: process.env.SENTRY_TEST_PROJECT_ID,
      query: "is:unresolved",
      limit: 100,
    });

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: process.env.SENTRY_TEST_ISSUE_ID,
        }),
      ]),
    );
  }, 60000);

  it("retrieves the configured issue and its project", async () => {
    const result = await callTool("sentry_get_issue", {
      organization_id_or_slug: process.env.SENTRY_TEST_ORG,
      issue_id: process.env.SENTRY_TEST_ISSUE_ID,
    });

    expect(result).toEqual(
      expect.objectContaining({
        id: process.env.SENTRY_TEST_ISSUE_ID,
        project: expect.objectContaining({
          id: process.env.SENTRY_TEST_PROJECT_ID,
        }),
      }),
    );
  }, 60000);

  it("retrieves the sample event with exception details", async () => {
    const result = await callTool("sentry_list_issue_events", {
      organization_id_or_slug: process.env.SENTRY_TEST_ORG,
      issue_id: process.env.SENTRY_TEST_ISSUE_ID,
      full: true,
      per_page: 10,
    });

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventID: process.env.SENTRY_TEST_EVENT_ID,
          entries: expect.arrayContaining([
            expect.objectContaining({
              type: "exception",
              data: expect.objectContaining({
                values: expect.arrayContaining([
                  expect.objectContaining({
                    stacktrace: expect.objectContaining({
                      frames: expect.any(Array),
                    }),
                  }),
                ]),
              }),
            }),
          ]),
        }),
      ]),
    );
  }, 60000);
});
