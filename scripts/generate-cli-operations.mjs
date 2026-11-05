#!/usr/bin/env node
// Generate the amcp CLI's catalogue of management API operations by statically
// reading the backend controllers that use JwtOrManagementKeyGuard. No running
// server and no database: the backend's own route declarations are the source
// of truth. The output powers `amcp api --list` (discovery and examples) and a
// coverage check so a new management route cannot ship without the CLI knowing.
//
//   node scripts/generate-cli-operations.mjs           # write the file
//   node scripts/generate-cli-operations.mjs --check    # fail if it is stale
//
// Selection: any *.controller.ts under packages/backend/src whose class or a
// method is guarded by JwtOrManagementKeyGuard. Unguarded (public) routes on an
// otherwise-managed controller — e.g. File Share's public link endpoints — are
// left out, because an API key cannot and should not drive them.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND_SRC = join(ROOT, 'packages/backend/src');
const OUT = join(ROOT, 'packages/cli/src/generated/operations.ts');
const GUARD = 'JwtOrManagementKeyGuard';
const HTTP = new Map([
  ['Get', 'GET'], ['Post', 'POST'], ['Put', 'PUT'], ['Patch', 'PATCH'], ['Delete', 'DELETE'],
]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.controller.ts') && !name.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

// The single string literal argument of a decorator call, or '' when it has none.
function firstStringArg(call) {
  const arg = call.arguments?.[0];
  if (arg && ts.isStringLiteral(arg)) return arg.text;
  return '';
}

function decoratorName(dec) {
  const expr = dec.expression;
  const callee = ts.isCallExpression(expr) ? expr.expression : expr;
  return ts.isIdentifier(callee) ? callee.text : callee.getText();
}

// Does this decorator list carry @UseGuards(... JwtOrManagementKeyGuard ...)?
function hasGuard(decorators) {
  return decorators.some((dec) => {
    if (decoratorName(dec) !== 'UseGuards') return false;
    return ts.isCallExpression(dec.expression)
      && dec.expression.arguments.some((a) => a.getText().includes(GUARD));
  });
}

function apiOperationSummary(decorators) {
  for (const dec of decorators) {
    if (decoratorName(dec) !== 'ApiOperation') continue;
    const arg = ts.isCallExpression(dec.expression) ? dec.expression.arguments[0] : undefined;
    if (arg && ts.isObjectLiteralExpression(arg)) {
      for (const prop of arg.properties) {
        if (ts.isPropertyAssignment(prop) && prop.name.getText() === 'summary'
          && ts.isStringLiteral(prop.initializer)) return prop.initializer.text;
      }
    }
  }
  return '';
}

/** The @Roles(...) decorator in a list, or undefined when there is none. */
function rolesDecorator(decorators) {
  return decorators.find((dec) => decoratorName(dec) === 'Roles' && ts.isCallExpression(dec.expression));
}

/**
 * True when only admins may call the route. Mirrors RolesGuard, which uses
 * reflector.getAllAndOverride([handler, class]): a method-level @Roles wins,
 * otherwise the controller-level @Roles applies.
 */
function requiresAdmin(methodDecorators, classDecorators) {
  const roles = rolesDecorator(methodDecorators) ?? rolesDecorator(classDecorators);
  if (!roles) return false;
  const args = roles.expression.arguments.map((a) => a.getText());
  return args.length > 0 && args.every((a) => a.includes("'ADMIN'") || a.includes('"ADMIN"'));
}

function joinPath(base, sub) {
  const parts = `${base}/${sub}`.split('/').filter(Boolean);
  return `/${parts.join('/')}`;
}

function collect() {
  const ops = [];
  for (const file of walk(BACKEND_SRC)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes(GUARD)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    sf.forEachChild((node) => {
      if (!ts.isClassDeclaration(node)) return;
      const classDecs = ts.getDecorators(node) ?? [];
      const controller = classDecs.find((d) => decoratorName(d) === 'Controller');
      if (!controller || !ts.isCallExpression(controller.expression)) return;
      const base = firstStringArg(controller.expression);
      if (!base.startsWith('api/') && base !== 'api') return;
      const classGuard = hasGuard(classDecs);
      const resource = base.replace(/^api\/?/, '') || 'root';

      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        const decs = ts.getDecorators(member) ?? [];
        const verbDec = decs.find((d) => HTTP.has(decoratorName(d)));
        if (!verbDec || !ts.isCallExpression(verbDec.expression)) continue;
        if (!classGuard && !hasGuard(decs)) continue; // public route on a managed controller
        const method = HTTP.get(decoratorName(verbDec));
        const sub = firstStringArg(verbDec.expression);
        const path = joinPath(base, sub);
        const action = member.name.getText();
        const hasBody = (member.parameters ?? []).some((p) =>
          (ts.getDecorators(p) ?? []).some((d) => decoratorName(d) === 'Body'));
        ops.push({
          resource,
          action,
          method,
          path,
          summary: apiOperationSummary(decs),
          admin: requiresAdmin(decs, classDecs),
          pathParams: [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]),
          hasBody,
        });
      }
    });
  }
  ops.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return ops;
}

function render(ops) {
  const header = `// GENERATED by scripts/generate-cli-operations.mjs — do not edit by hand.
// Run \`node scripts/generate-cli-operations.mjs\` after changing a management
// controller (one guarded by JwtOrManagementKeyGuard). CI fails if this file is
// stale. It lists every management API operation the \`amcp\` CLI can drive, for
// \`amcp api --list\` and the CLI's coverage test.

export interface ApiOperation {
  /** Resource segment, e.g. "mcp-servers" (the controller base minus "api/"). */
  resource: string;
  /** The controller handler name, a stable per-resource action id. */
  action: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Full path with :params, e.g. "/api/mcp-servers/:id". */
  path: string;
  /** One-line summary from @ApiOperation, or "" when the route has none. */
  summary: string;
  /** True when the route is @Roles('ADMIN'): a non-admin key gets 403. */
  admin: boolean;
  pathParams: string[];
  /** True when the handler takes a request body (@Body). */
  hasBody: boolean;
}

export const OPERATIONS: readonly ApiOperation[] = ${JSON.stringify(ops, null, 2)};
`;
  return header;
}

const ops = collect();
const rendered = render(ops);
const check = process.argv.includes('--check');

if (check) {
  let current = '';
  try { current = readFileSync(OUT, 'utf8'); } catch { /* missing */ }
  if (current !== rendered) {
    console.error(`[generate-cli-operations] ${relative(ROOT, OUT)} is stale. Run: node scripts/generate-cli-operations.mjs`);
    process.exit(1);
  }
  console.log(`[generate-cli-operations] up to date (${ops.length} operations).`);
} else {
  writeFileSync(OUT, rendered);
  console.log(`[generate-cli-operations] wrote ${ops.length} operations to ${relative(ROOT, OUT)}`);
}
