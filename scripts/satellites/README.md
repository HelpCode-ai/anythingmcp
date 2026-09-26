# Satellite repositories

Small GitHub repositories that each package one slice of AnythingMCP for the
people searching for exactly that slice: `weclapp-mcp-server`, `soap-to-mcp`,
`erp-mcp-server` and so on. They are generated from the adapter JSON in this
repository, never written by hand, so they cannot drift from the product.

| File | What it is |
|---|---|
| `satellites.config.json` | Every satellite: owner, type, adapters, About, topics, website, related repos, `lastVerified` |
| `topic-counts.json` | GitHub repository count per topic, as measured; the checks refuse an unmeasured topic |
| `content/<repo>/` | Hand-written parts: `prompts.md`, `faq.md`, `auth.md`, `troubleshooting.md`, with `.<lang>.md` translations |
| `templates/` | Files copied into every satellite: install, smoke test, tools-table renderer, sync workflow, SOAP demo |
| `lib.mjs`, `readme.mjs` | Checks and file generation |
| `generate.mjs` | The CLI |

```bash
node scripts/satellites/generate.mjs --check                      # static checks, every satellite
node scripts/satellites/generate.mjs --check --online             # … plus HTTP 200 on each website
node scripts/satellites/generate.mjs --only weclapp-mcp-server    # write scripts/satellites/out/<owner>/<repo>/
node scripts/satellites/generate.mjs --check-publish --only weclapp-mcp-server
node --test scripts/satellites/satellites.test.mjs                # UPDATE_SNAPSHOTS=1 to accept a template change
```

Three levels of findings:

- **errors**: fix before anything reaches GitHub (About length and wording, objects the About promises but no tool provides, invalid or unmeasured topics, broken references);
- **blockers**: stop publishing but not generation (`lastVerified` is null, the adapter's own JSON says it is unverified, the licence is not decided, missing English prompts or FAQ);
- **warnings**: advisory.

`lastVerified` records how someone confirmed the connector against a live system,
for example real production traffic. The sync workflow in each satellite only
bumps the "Adapter synced" date; it never claims a verification.

`publish.mjs --only <repos>` creates or updates the repositories (see its header). GitHub has no API for social preview images: `social-preview.mjs --only <repos>` renders them to `out/social/`, to upload under Settings → Social preview.

Generation writes `out/apply-metadata.sh` with the `gh repo edit` commands for
About, website and topics. Nothing here creates or pushes a repository.

To verify a generated satellite end to end: `cd out/<owner>/<repo> && ./scripts/install.sh && npm install && node scripts/smoke.mjs`
(`COMPOSE_PROJECT_NAME`, `FRONTEND_PORT` and `BACKEND_PORT` avoid clashes with a local stack).
