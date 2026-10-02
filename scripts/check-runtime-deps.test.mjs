import test from 'node:test';
import assert from 'node:assert/strict';
import { nestedRuntimeDeps } from './check-runtime-deps.mjs';

test('flags a production package nested under the backend workspace', () => {
  const lock = {
    packages: {
      '': {},
      'node_modules/js-yaml': { version: '4.3.2' },
      'packages/backend/node_modules/js-yaml': { version: '5.4.1' },
      'packages/backend/node_modules/js-yaml/node_modules/argparse': { version: '2.0.1' },
    },
  };
  assert.deepEqual(nestedRuntimeDeps(lock).map((d) => d.name), [
    'js-yaml',
    'js-yaml/node_modules/argparse',
  ]);
});

test('ignores dev-only nested packages and hoisted ones', () => {
  const lock = {
    packages: {
      'node_modules/js-yaml': { version: '4.3.2' },
      'packages/backend/node_modules/typescript': { version: '6.0.0', dev: true },
      'packages/frontend/node_modules/react': { version: '19.0.0' },
    },
  };
  assert.deepEqual(nestedRuntimeDeps(lock), []);
});
