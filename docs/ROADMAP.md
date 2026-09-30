# AnythingMCP Roadmap

This is a **living document**. We publish it so users and contributors can see where AnythingMCP is going and propose changes. Pull requests welcome.

For the current shipped state, see the [latest release](https://github.com/HelpCode-ai/anythingmcp/releases).

---

## Now (in active development)

- More pre-built adapters — community-requested SaaS connectors prioritised in [GitHub Discussions](https://github.com/HelpCode-ai/anythingmcp/discussions)
- Improved adapter authoring DX — better validation errors, scaffolding CLI
- Tool-level rate limiting per role
- Sharper observability: per-tool latency histograms, error-rate dashboards

## Next (planned, not yet started)

- **Streaming tool responses** — for long-running tool calls (DB queries, file generation)
- **Tool composition** — declaratively chain tools without leaving the gateway
- **Multi-tenant Cloud parity** — feature parity between self-hosted and [cloud.anythingmcp.com](https://cloud.anythingmcp.com)
- **Adapter marketplace** — install community adapters from a curated index, similar to a plugin registry
- **gRPC connector type** — first-class support for gRPC services alongside REST/SOAP/GraphQL
- **Webhook ingestion** — register webhooks as MCP "events" consumable by clients
- **Fine-grained tool versioning** — pin AI agents to specific tool versions
- **Native MCP elicitation & resources** — beyond tools, full MCP spec coverage

## Later (under consideration)

- **Tool A/B testing** — version-flag tool definitions and route per-user
- **Self-tuning rate limits** based on AI client behavior
- **OpenTelemetry exporter** for traces and metrics
- **Plugin SDK in TypeScript and Python** for custom auth/transformations

## Out of scope (for now)

- Building our own LLM client
- Code-execution sandbox (use [E2B](https://e2b.dev) or similar instead)
- Replacing Postman/Insomnia as a general API client

---

## Every item here is an issue

Each line above has an issue you can read, argue with, or pick up:
**[label:roadmap](https://github.com/HelpCode-ai/anythingmcp/issues?q=is%3Aissue+is%3Aopen+label%3Aroadmap)**.
Several are deliberately open design questions rather than tasks — say so in the
comments before writing code, and we will not merge an implementation of a
design that has not been settled.

New here? **[good first issue](https://github.com/HelpCode-ai/anythingmcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)**
is the short list: a scaffolding CLI, better validation messages, live catalog
badges, a translated README, `ADOPTERS.md`. None of them need you to understand
the whole codebase.

## Suggest a feature

Open a [feature request](https://github.com/HelpCode-ai/anythingmcp/issues/new?labels=enhancement&template=feature_request.yml), [request an adapter](https://github.com/HelpCode-ai/anythingmcp/issues/new?template=adapter_request.yml), or start a thread in [Discussions → Ideas](https://github.com/HelpCode-ai/anythingmcp/discussions/categories/ideas).
