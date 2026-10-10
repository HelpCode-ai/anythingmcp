/**
 * Single source of truth for the backend version, commit and build date.
 *
 * The version is resolved by walking up from this file rather than with a
 * fixed relative path: tsc emits to `dist/src/...`, so the package.json sits
 * one level further up in the build than in the source tree, and the runtime
 * image moves it again (`/app/backend/package.json` against
 * `/app/backend/dist/src/common/`). A hardcoded `../../package.json` is
 * correct in exactly one of those three layouts, and being wrong throws
 * MODULE_NOT_FOUND at import time — which takes the whole backend down for a
 * string that appears in one handshake field. Hence also the try/catch: this
 * can degrade, it cannot fail to boot.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function readPackageVersion(): string {
  let dir = __dirname;
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

/** Package version, read from the nearest package.json. */
export const APP_VERSION: string = readPackageVersion();

/** Short commit SHA, or 'dev' when unset (local builds, source runs). */
export const APP_COMMIT: string =
  process.env.APP_COMMIT || process.env.SENTRY_RELEASE || 'dev';

/** Build date (ISO), or null when unset. */
export const APP_BUILD_DATE: string | null =
  process.env.APP_BUILD_DATE || null;
