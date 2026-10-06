# Agent instructions

Read [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md) before making changes.
Never add or change code under any `ee/` directory: it uses the AnythingMCP
Commercial License; use AGPL-3.0-only for the rest of the repository.
Read [LICENSING.md](LICENSING.md), [the EE README](packages/backend/src/ee/README.md),
and [the license FAQ](docs/license-faq.md) for that boundary.
Sign the [CLA](CLA.md) once before your first PR can merge; follow the automated
check from `.github/workflows/cla.yml`.
Follow nested `AGENTS.md` instructions within their folders; leave
`scripts/demo-video/compositions/AGENTS.md` to the unrelated video tooling.

## Setup

Use Node.js >= 22.12 (root `package.json`), npm >= 9, and Docker with Compose.
Run the interactive setup from the repository root:

```bash
./setup.sh
```

Choose **Local development** and localhost. Let setup generate and symlink `.env`,
install dependencies, start PostgreSQL, apply migrations, and generate Prisma.
Keep `.env` uncommitted.
Use the default local PostgreSQL port 5433; match `DATABASE_URL` to that port.
For manual setup, follow CONTRIBUTING and replace its Docker-only database host
with localhost. Do not use the example production placeholders as real secrets.
Start the development database and install the locked dependencies from the root:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres
npm ci
```

In `packages/backend`, export the local `.env`: Prisma requires `DATABASE_URL`
in the environment. Apply existing migrations and generate the client:

```bash
set -a
. ../../.env
set +a
npx prisma migrate deploy
npx prisma generate
```

## Run

Run both development servers from the root:

```bash
npm run dev
```

Use the backend at http://localhost:4000 and frontend at http://localhost:3000.
Stop the servers when finished, and before starting Playwright's own Next server.
Keep incidental Next.js changes out of focused PRs: it may create frontend
`AGENTS.md` / `CLAUDE.md` and update `next-env.d.ts`.

## Test, lint, and typecheck

Match `.github/workflows/ci.yml`; run backend checks in `packages/backend`
after Prisma generation:

```bash
npm run lint
npx tsc --noEmit -p tsconfig.json
npm test
```

Review the diff after backend lint: its `eslint --fix` script rewrites files.
Keep only intentional changes, and never include an `ee/` change.
Use Jest `*.spec.ts` beside the backend source, including adapter static specs.
Record baseline failures separately from regressions; never claim a failed run passes.
Avoid root `npm test`: it runs tests in all workspaces and fails because the
frontend has no `test` script. Use the backend command above for catalog tests.

Run frontend checks in `packages/frontend`:

```bash
npm run lint
npx tsc --noEmit -p tsconfig.json
```

Run frontend Playwright in `packages/frontend`, following `playwright.yml`.
Install Chromium and OS libraries with sufficient system-install privileges:

```bash
npx playwright install --with-deps chromium
npm run test:e2e
```

Treat a failed OS dependency install as a prerequisite failure, not a test pass.
Use `packages/frontend/tests/e2e/`; let Playwright start `next dev` on port 3100.
Keep the normal dev server stopped to avoid Next's lock on the same `.next` dir.
Expect the frontend smoke tests to mock API calls; do not require a live backend.

## Project map

- Use `packages/backend/src/<feature>/` for NestJS modules (controller, service, DTO, spec).
- Use `packages/backend/prisma/schema.prisma` and `prisma/migrations/` for data.
- Use `packages/backend/src/adapters/<region>/<slug>.json` for adapters; generate `catalog.ts`.
- Use `packages/frontend/src/app/` for Next.js App Router pages and layouts.
- Use `content/guides/` for website guides, `docs/` for docs, and `scripts/` for tooling.

## Add an adapter: six steps

Read [docs/tool-definition.md](docs/tool-definition.md); run adapter commands from the root.

1. Scaffold a JSON file; replace the example slug, region, and auth as needed:
   ```bash
   npm run adapter:new -- my-service --region intl --auth API_KEY
   ```
   Match the filename to the slug; prefix tools with `<slug_with_underscores>_`.
   Replace every TODO and use credential variable references, never real secrets.
2. Validate the catalog and resolve warnings introduced by your adapter:
   ```bash
   node scripts/validate-adapters.mjs --warn
   ```
   Distinguish existing warnings from new ones; exit zero does not mean no warnings.
3. Regenerate the catalog and commit its intentional diff:
   ```bash
   node scripts/regenerate-catalog.mjs
   ```
4. Add `<region>/<slug>.live.spec.ts`; start from `intl/todoist.live.spec.ts`.
   Always run static assertions; gate live calls behind `RUN_<SLUG>_LIVE=1`.
5. Check the quoted counts and update the files the checker names:
   ```bash
   node scripts/adapter-count.mjs --check
   ```
6. Add the logo at `packages/frontend/public/logos/connectors/<icon>.svg`.

## Hard rules and deployment modes

Keep every organization-scoped query filtered by `organizationId`.
Never log secrets; use NestJS `Logger` instead of production `console.log`.
Validate input through DTOs with `class-validator`; follow existing NestJS patterns.
Open an issue before changing the Prisma schema, and include a migration.
Discuss new connector types, authentication changes, breaking APIs, and large refactors first.
State how every feature behaves in both Cloud and self-hosted deployments.
Use `packages/backend/src/common/deployment.service.ts` for `isCloud()` and
`isSelfHosted()`: `DEPLOYMENT_MODE=cloud` selects Cloud; the default is self-hosted.
Use `packages/frontend/src/lib/use-edition.ts` for self-hosted edition state;
expect its `edition` field to be null on Cloud, while loading, and when signed out.
Keep these instructions documentation-only in both modes; include no Cloud operator procedures.

## Branches, PRs, and AI-assisted contributions

Fork and branch from `main`; use `docs/description`, `fix/description`,
`feat/description`, or `refactor/description` as appropriate.
Write imperative commit subjects under 72 characters and reference the issue.
Keep PRs focused; fill out `.github/PULL_REQUEST_TEMPLATE.md`.
Update user-facing documentation and add tests for new behavior.
List the exact commands, working directories, and actual results in the PR.
Note incorrect existing documentation; review every AI-assisted line and own the result.
Require the backend catalog tests and adapter validation; report any baseline failures.
Write the reason for the change in your own words; never paste AI output blindly.
Push to your fork, target upstream `main`, and complete the one-time CLA check.
