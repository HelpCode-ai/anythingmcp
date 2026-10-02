#!/usr/bin/env node
/**
 * Fails when a production dependency of the backend is nested under
 * packages/backend/node_modules in package-lock.json.
 *
 * The Docker runtime stage copies only the hoisted /app/node_modules of the
 * prod-deps stage into backend/node_modules. npm nests a package under the
 * workspace when the backend needs a different version of something the root
 * also needs. That copy never reaches the image: the backend then loads the
 * root's version and can crash at boot, while unit tests (which resolve the
 * nested copy) stay green. js-yaml 5 did exactly that on 2026-10-02 (#809).
 *
 * Fix it by aligning versions so npm can hoist one copy, or change the
 * Dockerfile to ship nested packages (and keep the root's copy for the
 * packages that need it) before allowing an exception here.
 *
 *   node scripts/check-runtime-deps.mjs            # checks ./package-lock.json
 *   node scripts/check-runtime-deps.mjs <lockfile>
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const NESTED = 'packages/backend/node_modules/';

/** Production packages the lockfile nests under the backend workspace. */
export function nestedRuntimeDeps(lock) {
  return Object.entries(lock.packages ?? {})
    .filter(([path, meta]) => path.startsWith(NESTED) && !meta.dev)
    .map(([path, meta]) => ({ name: path.slice(NESTED.length), version: meta.version }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const file = process.argv[2] ?? join(root, 'package-lock.json');
  const nested = nestedRuntimeDeps(JSON.parse(readFileSync(file, 'utf8')));
  if (nested.length === 0) {
    console.log('No backend production dependency is nested: the runtime image gets them all.');
    process.exit(0);
  }
  console.error('::error::These backend production dependencies are nested under packages/backend/node_modules');
  console.error('and would be missing from the Docker image (it ships only the hoisted node_modules):');
  for (const d of nested) console.error(`  - ${d.name}@${d.version}`);
  console.error('Align the versions so npm hoists a single copy. See scripts/check-runtime-deps.mjs.');
  process.exit(1);
}
