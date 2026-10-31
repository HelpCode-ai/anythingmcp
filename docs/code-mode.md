# Code mode

Code mode lets an AI client run a short JavaScript program that orchestrates
several of a workspace's MCP tools in one step, instead of making the tool
calls one at a time. A program that filters, joins or loops over tool results
turns dozens of round trips and megabytes of intermediate data into a single
call that returns only what matters.

> **Off by default, everywhere.** Code mode does nothing until an operator runs
> the code-runner service (`CODE_RUNNER_URL`) **and** a workspace turns it on
> per MCP server (`codeMode`). With either missing, code runs are refused —
> never executed in the main process.

## How code runs safely

Code is untrusted by construction: a prompt-injected tool result can steer what
the model writes. So it never runs in the AnythingMCP backend. It runs in a
separate **code-runner** container, one locked-down subprocess per run, with no
filesystem, no network, no environment and no subprocess access. The only thing
a program can do is call the MCP tools the caller is already allowed to use,
through an `amcp` bridge the backend answers under that caller's role. The full
containment model and its verification are in
[`deploy/code-runner/README.md`](../deploy/code-runner/README.md).

Inside a program you have one capability:

```js
// Discover tools, read their schema, and call them.
const tools = await amcp.search('invoice');
const schema = await amcp.describe('list_invoices');
const invoices = await amcp.run('list_invoices', { customerId: args.customerId });
return invoices.filter((i) => i.status === 'open').map((i) => i.id);
```

`amcp.run` is governed exactly like a direct tool call: the caller's role
decides what it may reach, and read/write rules still apply.

## Two forms

**Saved code tools.** A reusable tool whose body is a stored program. It is an
ordinary MCP tool (it shows up in `tools/list`, obeys role access, is audited
and can be exported), created in the dashboard under a connector's tools with
the **Code** tool type. A saved code tool declares:

- **Uses** — the connectors (optionally specific tools) the program may call.
  Only connectors from the same workspace.
- **Run as** — `invoker` re-checks the calling user's own permissions on every
  inner call; `definer` runs with the author's curation instead (like a stored
  procedure), still limited to *Uses* and the write setting. Definer is
  admin-only.
- **Allow write tools** — off means the program may call only read-only tools.
  Turning it on needs AnythingMCP Enterprise.

**Inline code (`code_execute`).** A generic tool the model can call with a
program it writes on the spot. Always read-only and with the caller's own
permissions, over the connectors they can reach on that server. It appears only
when the server's `codeMode` is `inline` and the caller's role carries the
`inlineCode` capability.

## Governance

- **Per server:** `codeMode` is `off` (default), `tools` (saved code tools
  only) or `inline` (also `code_execute`).
- **Per role:** the `inlineCode` capability gates inline code; saved code tools
  follow the normal tool allow-list.
- **Writes** happen only in an admin-approved code tool with *Allow write
  tools* on; inline code and read-only tools can never write.
- **Audit:** every run is recorded (a `code_runs` row), and each tool call the
  program makes is recorded like any other tool call.
- **Shared endpoint:** code tools are never served on the shared `/mcp`
  endpoint used by directory AI clients; they run only on a workspace's own MCP
  servers.

## Deployment

Code mode is the same feature on Cloud and self-hosted; both run the runner as
a separate service and refuse code runs when it is unreachable.

Self-hosted, with Docker Compose:

```env
COMPOSE_PROFILES=code-runner
CODE_RUNNER_URL=ws://code-runner:8777
```

Then set a server's `codeMode` to `tools` or `inline`. The runner holds no
secrets and needs no inbound internet; it accepts only the backend's connection
on the internal network.

## Limits

A run is bounded by a wall-clock deadline, a memory ceiling, a cap on how many
tool calls it may make, and limits on output size. A program that exceeds a
limit fails with a clear error; it never affects other runs or the backend.
