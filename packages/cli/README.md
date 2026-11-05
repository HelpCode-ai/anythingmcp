# AnythingMCP CLI

The `amcp` command connects to one AnythingMCP MCP server from your terminal.
It supports login, logout, profile inspection, tool discovery and tool calls.

## About AnythingMCP

[AnythingMCP](https://anythingmcp.com) is an enterprise **agent harness and MCP
gateway**: it turns any API, SaaS or data source into [MCP](https://modelcontextprotocol.io)
tools your AI agents can use — Claude, ChatGPT, Cursor and others. Connect
services like Odoo, Etsy, Shopify and HubSpot, SQL and NoSQL databases, and
SFTP/FTP or SMB file shares, then govern who and which agent may reach each one.
Run it on AnythingMCP Cloud or self-host it (AGPL-3.0). Source and docs:
[github.com/HelpCode-ai/anythingmcp](https://github.com/HelpCode-ai/anythingmcp).

This package is the command-line client. Beyond calling MCP tools, it drives the
management API with a management-scoped key, so a person — or a connected agent —
can configure the whole instance (connectors, MCP servers, users, roles, SSO,
settings and more) without leaving the terminal.

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
shows only a key prefix. One profile can hold both an MCP key (for `tools`) and
a management key (for `api`): logging in with one keeps the other when both
point at the same instance. `amcp --version` prints the CLI version.

`tools ls` shows each tool's name, read-only/destructive hint, and the first
line of its description. `tools describe` shows the full description and input
JSON schema. Use that schema to prepare arguments for `tools call`:

```bash
amcp tools describe YOUR_TOOL_NAME
amcp tools call YOUR_TOOL_NAME --args '{"id":"123"}'
amcp tools call YOUR_TOOL_NAME --args @args.json
cat args.json | amcp tools call YOUR_TOOL_NAME --args -
```

Without `--args`, the CLI sends an empty object. Arguments must be a JSON
object. Calls time out after 300 seconds by default. Set `--timeout <seconds>`
on `tools call` for a different positive timeout (fractional seconds are allowed).
A timeout exits with code 4 and reports `Tool call timed out after <seconds>s`.
For a tool annotated as destructive, an interactive terminal asks for
confirmation. In a non-interactive script, pass `--yes` explicitly. Tool text
goes to stdout, and non-text content is available with `--json`.

`--json` works with every command. It writes one JSON object to stdout: login
and logout report the profile, `whoami` reports the instance URL, MCP `endpoint`
and masked key, `tools ls` returns `{ "tools": [...] }`,
`tools describe` returns `{ "tool": {...} }`,
and `tools call` returns `{ "tool": "name", "result": {...} }`. CLI usage and
connection errors go to stderr (also as JSON when `--json` is set). A tool's
`isError` result is returned on stdout in JSON mode and on stderr in text mode.
JSON errors on stderr have the shape `{ "error": "message", "exitCode": 4 }`.
For example:

```bash
amcp tools ls --json
amcp tools call YOUR_TOOL_NAME --args @args.json --json
```

Exit codes are `0` for success, `1` when a tool returns `isError`, `2` for
invalid usage or JSON arguments, `3` for authentication failures, and `4` for
connection or server failures. The API key is never accepted as an argument
and is never included in CLI status output.

## Shell completion

`amcp completion <bash|zsh|fish>` prints a completion script for commands,
`tools` subcommands and each command's flags. Install it once for your shell:

```bash
amcp completion bash > ~/.local/share/bash-completion/completions/amcp
amcp completion zsh > "${fpath[1]}/_amcp"
amcp completion fish > ~/.config/fish/completions/amcp.fish
```

Bash needs the `bash-completion` package for the directory above; without it,
add `source <(amcp completion bash)` to `~/.bashrc`. In zsh, `compinit` must be
enabled; to load the script without writing a file, add
`source <(amcp completion zsh)` to `~/.zshrc` after `compinit`. Open a new shell
afterwards. The scripts are static and do not read the config file or contact a
server, so profile and tool names are not completed. `completion` always prints
the script as plain text, even with `--json`. Any shell other than `bash`, `zsh`
or `fish` exits with code `2`.

## Management API (`amcp api`)

Beyond calling MCP tools, `amcp` can drive the instance's **management API**
(`/api/*`) — connectors, MCP servers, roles, users, SSO, settings, memory,
skills, the knowledge graph and more — with a **management-scoped** API key.

A management key is an ordinary MCP API key minted with a management scope
(`MANAGEMENT_READ` or `MANAGEMENT_ADMIN`) from the dashboard or `POST
/api/mcp-keys`. It carries the owner's identity and role: it never grants
privilege, so admin-only routes still require an admin owner. `MANAGEMENT_READ`
keys may call only safe methods (GET/HEAD), and connector exports made with
them never include secrets, even for an admin owner.

### Getting a management key

Mint one from the dashboard (Settings → Management API keys), choosing
read-only or admin, or let the CLI do it through the browser:

```bash
amcp login --browser --url https://cloud.anythingmcp.com            # read-only
amcp login --browser --scope admin --url https://cloud.anythingmcp.com
```

`--browser` opens the instance's authorization page, where you approve the
request under your existing dashboard session (SSO included). The CLI prints a
short verification code that must match the page before you approve. The key is
minted by the dashboard and returned to the CLI over a one-shot `127.0.0.1`
loopback, so it never appears in a URL, log or shell history; it is an ordinary
management key you can see and revoke in Settings. On a headless machine, set
`AMCP_NO_BROWSER=1` and open the printed URL yourself. The admin scope is
available only to workspace admins. This is additive: the key-based `login
--management` below is unchanged.

### Using a management key

Log in with a management key (no server needed), then call any endpoint:

```bash
printf '%s\n' "$AMCP_API_KEY" | amcp login --management --url https://cloud.anythingmcp.com --key-stdin
amcp api GET /api/connectors
amcp api GET /api/mcp-servers
amcp api POST /api/mcp-servers --data '{"name":"ops","description":"Ops server"}'
amcp api PUT  /api/mcp-servers/SERVER_ID --data '{"codeMode":"tools"}'
```

For CI, skip the profile and pass the key in the environment:

```bash
AMCP_URL=https://cloud.anythingmcp.com AMCP_API_KEY=mcp_… amcp api GET /api/users --json
```

To discover what the management API offers, list its operations (no key and no
network — the catalogue ships with the CLI):

```bash
amcp api --list                 # every management operation, grouped by resource
amcp api --list mcp-servers     # only one resource
amcp api --list --json          # { "operations": [ { method, path, summary, admin, … } ] }
```

Each line shows the method, path, an `[admin]` tag when the route needs an admin
owner, a `[body]` tag when it takes a request body, and the summary. The
catalogue is generated from the backend controllers, and CI fails if a new
management route is added without regenerating it, so `amcp api --list` always
matches the instance's API.

The key comes from `AMCP_API_KEY`, `--key-stdin`, or a saved management profile —
never from a command argument. A non-safe method asks for confirmation on a
terminal; pass `--yes` in scripts. `--data` accepts inline JSON, `@file.json` or
`-` (stdin). Output is the parsed JSON body; `--json` wraps it with the status.
Exit codes match the rest of the CLI: `1` for a 4xx result, `3` for 401/403,
`4` for 5xx or a connection failure. The management API applies a per-key
rate limit, so a runaway client is refused with HTTP 429 rather than hammering
the instance.
