# Getting help with AnythingMCP

Different questions go to different places — please use the right channel so we can answer faster.

## Ask the community first

The fastest answers usually come from other users. Before opening an issue, check:

- **[GitHub Discussions](https://github.com/HelpCode-ai/anythingmcp/discussions)** — Q&A, ideas, show & tell
  - **Q&A** for "how do I…" questions
  - **Ideas** for feature requests and "please add adapter X"
  - **Show and tell** for sharing what you built
  - **Announcements** for release notes and roadmap updates

## Documentation

- **[README](README.md)** — overview and quick start
- **[anythingmcp.com](https://anythingmcp.com)** — website with 150+ guides for individual adapters and AI clients (English / German / Italian)
- **[Deployment Guide](docs/deployment.md)** — production self-hosting
- **[API Reference](docs/api-reference.md)** — full REST API
- **[Tool Definition Format](docs/tool-definition.md)** — how adapter JSON files are structured
- **[License FAQ](docs/license-faq.md)** — what the AGPL-3.0 license means in practice

## Bug reports

Found a reproducible bug? [Open an issue](https://github.com/HelpCode-ai/anythingmcp/issues/new/choose) using the **Bug report** template. Please include:

- Version (`docker compose exec backend npm version`, or `git rev-parse HEAD` for source builds)
- Deployment mode (Docker / Railway / DigitalOcean / Cloud)
- The smallest possible reproduction steps
- Logs (sanitise any credentials first)

## Security issues

**Do not** open a public issue for security vulnerabilities. Follow the [SECURITY.md](SECURITY.md) policy and email **info@helpcode.ai** instead.

## Commercial support

For commercial licensing, custom adapter development, on-prem support contracts, or SLA-backed Cloud plans:

📧 **info@helpcode.ai** &nbsp; · &nbsp; 🌐 **[helpcode.ai](https://helpcode.ai)**

## Stay in the loop

- ⭐ **Star** the repo
- 👀 **Watch → Custom → Releases** to be notified about new versions and adapters
- 📣 Follow [@helpcode_ai](https://twitter.com/helpcode_ai) for release announcements
