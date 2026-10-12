import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Backend version, reported as the demo server's version (was a hardcoded 1.0.0).
 *
 * Resolved by walking up from this file rather than with a fixed relative path:
 * tsc emits to `dist/src/...`, so the package.json sits one level further up in
 * the build than in the source tree, and the runtime image moves it again
 * (`/app/backend/package.json` against `/app/backend/dist/src/common/`).
 * A hardcoded `../../package.json` is correct in exactly one of those three
 * layouts, and being wrong throws MODULE_NOT_FOUND at import time — which takes
 * the whole backend down for a string that appears in one handshake field.
 * Hence also the try/catch: this can degrade, it cannot fail to boot.
 */
export function readAppVersion(startDir: string = __dirname): string {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(
        readFileSync(join(dir, 'package.json'), 'utf8'),
      ) as { name?: string; version?: string };
      if (pkg.name && pkg.version) return pkg.version;
    } catch {
      /* keep walking */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}

/**
 * Commit baked into the image. `APP_COMMIT` wins; published images that only
 * set `SENTRY_RELEASE` still report that sha. Source checkouts and local
 * image builds have neither, and show `dev`.
 */
export function readAppCommit(env: NodeJS.ProcessEnv = process.env): string {
  return env.APP_COMMIT || env.SENTRY_RELEASE || 'dev';
}

/** Set by the image build. Local builds leave it unset. */
export function readAppBuildDate(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.APP_BUILD_DATE || null;
}

export const APP_VERSION: string = readAppVersion();
export const APP_COMMIT: string = readAppCommit();
export const APP_BUILD_DATE: string | null = readAppBuildDate();

/** Seven characters of a 40-hex SHA. `dev` and an already-short value stay as written. */
export function shortCommit(commit: string): string {
  return /^[0-9a-f]{40}$/.test(commit) ? commit.slice(0, 7) : commit;
}

/**
 * Startup line. The commit is shortened for the log; `GET /api/version` keeps
 * the full value so the footer can link to it.
 */
export function formatVersionLogLine(input: {
  version: string;
  commit: string;
  buildDate: string | null;
  deploymentMode: string;
}): string {
  const built = input.buildDate || 'unknown';
  return (
    `AnythingMCP v${input.version} ` +
    `(commit ${shortCommit(input.commit)}, built ${built}, mode ${input.deploymentMode})`
  );
}
