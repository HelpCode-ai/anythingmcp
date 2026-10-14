# AnythingMCP CLI

The `amcp` command connects to one AnythingMCP MCP server from your terminal.
This first version supports login, logout, profile inspection and tool listing.

From the repository root:

```bash
npm install
npm run build -w packages/cli
node packages/cli/dist/index.js login --url http://localhost:4000 --server YOUR_SERVER_ID
node packages/cli/dist/index.js tools ls
```

`login` prompts for an MCP API key without displaying it. For scripts, use
`--key-stdin` or the `AMCP_API_KEY` environment variable. Never put the key in
a command argument. The CLI verifies the key by requesting `tools/list` before
saving it. It always connects to `/mcp/<serverId>`, including on Cloud, because
the bare `/mcp` endpoint exposes a different tool set there. Pass the instance
base URL to `--url`, without `/mcp/<serverId>`. HTTPS is required except for
`localhost`, `127.0.0.0/8`, and `::1` during local development. Redirects are
refused so the API key cannot follow a request to another origin.

```bash
printf '%s\n' "$AMCP_API_KEY" | amcp login --url https://cloud.anythingmcp.com \
  --server YOUR_SERVER_ID --key-stdin --profile cloud
amcp tools ls --profile cloud --filter customer
amcp whoami --profile cloud
amcp logout --profile cloud
```

For CI, `AMCP_URL`, `AMCP_SERVER` and `AMCP_API_KEY` can provide connection
details without saving a profile. `--url` and `--server` take precedence over
their matching environment variables. If a URL is supplied by `--url` or
`AMCP_URL`, supply `AMCP_API_KEY` too; a saved profile key is used only with its
saved origin. Profiles live in
`$XDG_CONFIG_HOME/amcp/config.json` or `~/.config/amcp/config.json`, with file
mode `0600` on Unix. Relative `XDG_CONFIG_HOME` values are ignored. `whoami`
shows only a key prefix.

`tools ls` shows each tool's name, read-only/destructive hint, and the first
line of its description. Tool execution and JSON output are planned for the
next phase of [issue #1009](https://github.com/HelpCode-ai/anythingmcp/issues/1009).
