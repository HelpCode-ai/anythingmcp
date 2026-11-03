# AnythingMCP Roadmap

This is a **living document**. We publish it so users and contributors can see where AnythingMCP is going and propose changes. Pull requests welcome.

AnythingMCP started as an MCP gateway: one governed endpoint in front of the APIs, ERPs and databases a company already runs. It is growing into a **company brain** for AI agents: the same endpoint also knows where the documents are, how the systems connect, how the company works and what it has decided, and serves that to every AI client within each user's role.

For the current shipped state, see the [latest release](https://github.com/HelpCode-ai/anythingmcp/releases).

---

## Shipped recently

- **File Search and File Share** (v0.52.0): a searchable index of SFTP, FTP/FTPS, WebDAV, S3 and network-share folders, with search, find, grep and read tools for every AI client, and temporary download links. [Docs](connectors/file-search.md)
- **Code Mode** (v0.52.0): one short program that calls several tools, in an isolated runner with no secrets and no network; saved code tools turn a recurring chain into a single tool, which answers most of [tool composition (#986)](https://github.com/HelpCode-ai/anythingmcp/issues/986). [Docs](code-mode.md)
- **Company memory** (Enterprise): facts and preferences saved from one AI client and found by every other, personal or company-wide, in folders with role limits. [Docs](memory.md)
- **AI skills v2**: on-demand skills and procedures with versions, folders and usage, learned from real requests and fixed errors and approved by an admin. [Docs](knowledge-graph.md#ai-skills)
- **MCP resources** on per-server endpoints. [Docs](mcp-resources.md)
- **Inbound webhooks**, first slice: Stripe events stored per connector and readable as a tool ([#988](https://github.com/HelpCode-ai/anythingmcp/issues/988) stays open for other providers).
- **Per-user sign-in** for OAuth2 connectors, so each user calls the upstream system as themselves. [Docs](connectors/per-user-sign-in.md)
- **E-mail connector** (IMAP/SMTP), connector export and import as JSON/YAML, Prometheus `/metrics` for tool calls, and the app in German and Italian.
- **691 catalog connectors** (from 561 in v0.51).

## Now (in active development)

- More pre-built adapters, prioritised by the searches that found nothing and by [adapter requests](https://github.com/HelpCode-ai/anythingmcp/issues?q=is%3Aissue+is%3Aopen+label%3Aadapter-request)
- File Search: more sources and file types, and folder permissions synced from the source system
- [Tool-level rate limiting per role (#983)](https://github.com/HelpCode-ai/anythingmcp/issues/983)
- [Per-tool latency histograms and an error-rate view (#984)](https://github.com/HelpCode-ai/anythingmcp/issues/984), on top of the Prometheus metrics

## Next (planned, not yet started)

- [Streaming tool responses for long-running calls (#985)](https://github.com/HelpCode-ai/anythingmcp/issues/985)
- [Webhook ingestion beyond Stripe (#988)](https://github.com/HelpCode-ai/anythingmcp/issues/988)
- [Cloud ↔ self-host export and import of a whole workspace (#992)](https://github.com/HelpCode-ai/anythingmcp/issues/992)
- [Adapter marketplace: install community adapters from a curated index (#993)](https://github.com/HelpCode-ai/anythingmcp/issues/993)
- [gRPC connector type (#987)](https://github.com/HelpCode-ai/anythingmcp/issues/987)
- [Fine-grained tool versioning (#989)](https://github.com/HelpCode-ai/anythingmcp/issues/989)
- A Helm chart for Kubernetes installs

## Later (under consideration)

- [OpenTelemetry metrics exporter (#990)](https://github.com/HelpCode-ai/anythingmcp/issues/990); traces are already exported over OTLP ([observability](operations/observability.md))
- [Plugin SDK for custom auth and transformations (#991)](https://github.com/HelpCode-ai/anythingmcp/issues/991)
- Tool A/B testing: version-flag tool definitions and route per user
- Self-tuning rate limits based on AI client behaviour

## Out of scope (for now)

- Building our own LLM client or chat app: AnythingMCP serves the AI clients you already use
- Replacing Postman or Insomnia as a general API client

---

## Every item here is an issue

Most lines above link to an issue you can read, argue with, or pick up:
**[label:roadmap](https://github.com/HelpCode-ai/anythingmcp/issues?q=is%3Aissue+is%3Aopen+label%3Aroadmap)**.
Several are deliberately open design questions rather than tasks — say so in the
comments before writing code, and we will not merge an implementation of a
design that has not been settled.

New here? **[good first issue](https://github.com/HelpCode-ai/anythingmcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)**
is the short list, mostly single-file catalog adapters. None of them need you to
understand the whole codebase.

## Suggest a feature

Open a [feature request](https://github.com/HelpCode-ai/anythingmcp/issues/new?labels=enhancement&template=feature_request.yml), [request an adapter](https://github.com/HelpCode-ai/anythingmcp/issues/new?template=adapter_request.yml), or start a thread in [Discussions → Ideas](https://github.com/HelpCode-ai/anythingmcp/discussions/categories/ideas).
