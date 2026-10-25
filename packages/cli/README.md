# AnythingMCP CLI

The `amcp` command connects to one AnythingMCP MCP server from your terminal.
It supports login, logout, profile inspection, tool discovery and tool calls.

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
