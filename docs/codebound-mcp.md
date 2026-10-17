# Let an AI write and run Codebound scripts

An MCP client can now discover connector schemas, submit its own JavaScript,
save a useful workflow, and reuse it. You do not need a script for every tool
or connector: a script represents a task and can combine several connector
reads before returning a small result.

The AI client writes the source. AnythingMCP executes it in the existing
Codebound sandbox; this feature does not call a model or require an LLM API key
on the backend.

## Connect a client

1. Follow the [local setup and test guide](codebound-testing.md) to start the app
   and create the sample `setup_demo_get_post` tool if needed.
2. In **Build → MCP Servers**, open the server with your connector assigned.
3. Connect your MCP client using the server's displayed endpoint, normally
   `http://localhost:4000/mcp/<server-id>` for local development. Use the existing
   OAuth sign-in flow, or generate a per-user key under the server's **API keys**
   section and configure it in your client's `X-API-Key` or bearer header.
4. Refresh the client's tool list. Reconnect if it caches schemas. Look for the
   six `codebound_` tools below.

Codebound requires an identified workspace member. It is not exposed by the
anonymous demo, anonymous access, or instance-level static credentials.

The same tools are available on the shared `/mcp` endpoint in both its fixed
and direct modes. On an unpinned shared connection, call `codebound_list_tools`
with `{}` first to discover reachable servers, then supply `serverId` in later
calls. On a per-server endpoint or a server-pinned key, `serverId` can be omitted.

## Available tools

| Tool | Purpose |
| --- | --- |
| `codebound_list_tools` | Discover reachable servers or a server's permitted REST read tools, descriptions, and input/output schemas. Supports `query`, `offset`, and `limit`. |
| `codebound_run` | Execute supplied `code`, `input`, and `allowedTools` without saving. |
| `codebound_save_script` | Create a reusable workflow; update an existing one by supplying `scriptId` and its reviewed `revision`. Editors/admins only. |
| `codebound_list_scripts` | List accessible saved workflows and revisions for one server. Follow `nextOffset` to scan further pages. |
| `codebound_get_script` | Read saved source, defaults, allowlist, and current revision before editing or reusing it. |
| `codebound_run_saved` | Run a saved ID and reviewed revision; optionally override `input` for this run. |

Saved scripts use `codebound_run_saved`; this version does not register a
separate MCP tool name for every saved script. Scripts created through MCP also
appear in the **Build → Codebound** UI. UI-created scripts are available through
MCP when their server and tool allowlist are within the current connection.

## Try it with an AI

With the demo connector assigned to the connected server, send this to your MCP
client:

> Use Codebound to inspect my permitted connector tool schemas. Write and run a
> JavaScript workflow that calls setup_demo_get_post and returns only its numeric
> ID and title. Validate those response fields. Then save the successful workflow
> as Post summary and run the saved version again. Write the script yourself.

The expected sequence is discovery → generated script → execution → save → reuse.
Your client's normal permissions for reading, running, and saving tools apply.

You can also exercise the same sequence in MCP Inspector's **Tools** view.
For a per-server endpoint, first call `codebound_list_tools` with:

```json
{}
```

Then call `codebound_run` with:

```json
{
  "code": "const post = await tools.call('setup_demo_get_post', {}); if (!post || typeof post.id !== 'number' || typeof post.title !== 'string') throw new Error('Unexpected post response'); return { id: post.id, title: post.title };",
  "input": {},
  "allowedTools": ["setup_demo_get_post"]
}
```

The result contains `result`, `calls`, `durationMs`, and `runId`. Only the script's
final JSON reaches the client; the full intermediate post remains inside the run.

Call `codebound_save_script` with the same fields plus `name` and optionally
`description`. Its response includes the saved `id` and `revision`. Use the
actual values from that response when calling `codebound_run_saved`:

```json
{
  "scriptId": "<saved-id-from-the-response>",
  "revision": 1
}
```

Omitting `input` reuses saved defaults. Supplying it overrides defaults only for
that run. To edit a workflow, fetch it with `codebound_get_script`, then submit
the updated source/defaults/allowlist to `codebound_save_script` with its
`scriptId` and current `revision`. A stale version returns an error and must be
reopened, rather than silently overwriting or running new source.

## Response contracts and permissions

Tool output schemas may be `null`. In that case, the agent can inspect a bounded
sample or the response's field names, then validate the fields its script uses.
It should target the actual filtered connector response. A contract mismatch
should throw a clear error rather than return an incorrect business answer.

The connection's OAuth grant, pinned API-key server, endpoint server, active
membership, and current tool roles all constrain access. Arguments cannot change
the authenticated identity or widen the connection. These checks run again
before every nested connector call, including calls from saved scripts. Reused
stateful sessions use each request's current client scope.

Saved-script discovery/opening also requires its tools to remain available to
the caller. Inaccessible workflows are omitted from listings. A scan page can
therefore contain no items but still have `nextOffset`; continue with that offset.
Saving a workflow grants no connector access to its author or anyone reusing it.

The existing limits apply: 5-second worker wall time, 64 MiB QuickJS heap,
20 sequential connector reads, 1 MiB cumulative connector replies, and 32 KiB
final JSON. Tools are limited to eligible REST reads; imports, direct networking,
host access, nested scripts, and MCP built-in calls are unavailable inside scripts.
An already-started connector read can finish after timeout; its result is ignored.
Schema/source discovery responses are capped at 256 KiB; narrow the search or
lower the page limit if necessary.

Cloud and self-hosted deployments share this behavior. Existing workspace license
checks still apply; no authentication scheme, connector type, or schema migration
was added for this integration. The shared endpoint keeps its existing connector
helper tools and adds the six Codebound tools for identified callers.

## Verification

From `packages/backend`, run the focused suite with local PostgreSQL available
and the local `.env` exported as described in the setup guide:

```bash
RUN_CODEBOUND_DB=1 npm test -- --runInBand codebound
```

This exercises real MCP SDK discovery/invocation, real QuickJS execution,
save/reuse, endpoint scopes, API-key pinning, grant revocation, live role changes,
viewer write denials, error redaction, concurrent session scopes, and PostgreSQL
persistence/isolation. The MCP client tests use in-memory transports and
deterministic connector fixtures; they do not depend on an external AI account.

A separate local HTTP smoke check also verified real dashboard sign-in, a
server-pinned per-user MCP key, schema discovery, run/save/reuse, dashboard
interoperability, the shared endpoint, and denial of another server. Its temporary
workspace and fixture records were removed after the check.
