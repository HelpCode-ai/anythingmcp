#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { readConfig, writeConfig, profileName, type Profile } from './config.js';
import { listClientTools, listTools, serverUrl, withClient } from './mcp.js';
import { apiRequest, API_METHODS, type ApiMethod } from './rest.js';
import { completionScript, isShell } from './completion.js';
import { OPERATIONS } from './generated/operations.js';
import { browserAuthorize, type ManagementScopeArg } from './browser-auth.js';
import { hostname } from 'node:os';

class CliError extends Error {
  constructor(message: string, readonly exitCode: number) { super(message); }
}

function sameOrigin(url: string, storedUrl: string): boolean {
  try { return new URL(url).origin === new URL(storedUrl).origin; }
  catch { return false; }
}

/**
 * A management login on an existing profile keeps its MCP server and key when
 * they point at the same instance, so one profile can hold both credentials.
 */
function withManagementKey(previous: Profile | undefined, url: string, managementKey: string): Profile {
  const keep = previous && previous.server && previous.key && sameOrigin(url, previous.url);
  return { url, server: keep ? previous.server : '', key: keep ? previous.key : '', managementKey };
}

function instanceUrl(profile: Profile): string {
  return new URL(profile.url).toString().replace(/\/$/, '');
}

function print(value: unknown, json: boolean, plain: () => void): void {
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else plain();
}

function singleLine(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

function terminalText(value: string): string {
  return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ');
}

async function readToolArgs(value?: string): Promise<Record<string, unknown>> {
  let source = value ?? '{}';
  if (value === '-') {
    source = '';
    try { for await (const chunk of process.stdin) source += chunk.toString(); }
    catch { throw new CliError('Could not read --args from stdin', 2); }
  } else if (value?.startsWith('@')) {
    if (value.length === 1) throw new CliError('Specify a file after @ in --args', 2);
    try { source = await readFile(value.slice(1), 'utf8'); }
    catch { throw new CliError('Could not read --args file', 2); }
  }
  let parsed: unknown;
  try { parsed = JSON.parse(source); }
  catch { throw new CliError('--args must be a JSON object', 2); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('--args must be a JSON object', 2);
  }
  return parsed as Record<string, unknown>;
}

// Like readToolArgs but for a REST body: any JSON value is allowed, and an
// omitted value means no body. Supports inline JSON, @file and - (stdin).
async function readData(value: string): Promise<unknown> {
  let source = value;
  if (value === '-') {
    source = '';
    try { for await (const chunk of process.stdin) source += chunk.toString(); }
    catch { throw new CliError('Could not read --data from stdin', 2); }
  } else if (value.startsWith('@')) {
    if (value.length === 1) throw new CliError('Specify a file after @ in --data', 2);
    try { source = await readFile(value.slice(1), 'utf8'); }
    catch { throw new CliError('Could not read --data file', 2); }
  }
  try { return JSON.parse(source); }
  catch { throw new CliError('--data must be valid JSON', 2); }
}

async function confirmApi(method: string, path: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question(`${method} ${singleLine(path)} may change data. Run it? [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } catch { return false; }
  finally { prompt.close(); }
}

async function confirmDestructive(toolName: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question(`Tool ${singleLine(toolName)} may make changes. Run it? [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } catch { return false; }
  finally { prompt.close(); }
}

async function readKey(stdin: NodeJS.ReadStream, stderr: NodeJS.WriteStream, fromStdin: boolean): Promise<string> {
  if (fromStdin) {
    let input = '';
    for await (const chunk of stdin) input += chunk.toString();
    const key = input.trim();
    if (!key) throw new CliError('API key was empty', 2);
    return key;
  }
  if (!stdin.isTTY || !stdin.setRawMode) {
    throw new CliError('Use --key-stdin when input is not a terminal', 2);
  }
  stderr.write('MCP API key: ');
  return new Promise<string>((resolve, reject) => {
    let key = '';
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onError);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
    };
    const onEnd = () => { cleanup(); reject(new CliError('API key input ended', 2)); };
    const onError = () => { cleanup(); reject(new CliError('Could not read API key', 2)); };
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3 || byte === 4) {
          cleanup(); reject(new CliError('Cancelled', 2)); return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          if (!key) reject(new CliError('API key was empty', 2)); else resolve(key);
          return;
        }
        if (byte === 8 || byte === 127) key = key.slice(0, -1);
        else if (byte >= 32 && byte <= 126) key += String.fromCharCode(byte);
      }
    };
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
  });
}

/** The server message of an error response, flattened to one safe line. */
function serverMessage(data: unknown): string {
  const raw = (data as { message?: unknown } | null)?.message;
  const text = Array.isArray(raw) ? raw.filter((m) => typeof m === 'string').join('; ')
    : typeof raw === 'string' ? raw : '';
  return singleLine(text).trim().slice(0, 300);
}

const TARGETS = {
  mcp: { name: 'MCP server', the: 'the MCP server' },
  management: { name: 'Management API', the: 'the management API' },
} as const;

function classifyConnectionError(error: unknown, kind: keyof typeof TARGETS = 'mcp'): CliError {
  const target = TARGETS[kind];
  // MCP/HTTP errors may include request details. Do not print their message.
  const message = error instanceof Error ? error.message : '';
  const detail = error as { status?: number; data?: { status?: number }; cause?: { code?: string } } | null;
  const status = detail?.status ?? detail?.data?.status;
  if (status === 401 || status === 403 || /\b(401|403)\b/.test(message) ||
      (error instanceof Error && error.name === 'UnauthorizedError')) {
    // Tell a rejected key (401) from a key that is valid but not allowed here
    // (403), without printing the server's message (see above).
    const forbidden = status === 403 || (status !== 401 && /\b403\b/.test(message) && !/\b401\b/.test(message));
    if (forbidden) {
      return new CliError(kind === 'mcp'
        ? 'Forbidden (403): this key may not use this MCP server. Pass the server ID the key was created for, and check that the server is active'
        : 'Forbidden (403): this key may not perform this request', 3);
    }
    return new CliError('Authentication failed (401): the key is invalid, revoked or expired', 3);
  }
  if (typeof status === 'number' && status >= 400 && status <= 599) {
    return new CliError(`${target.name} returned HTTP ${status}`, 4);
  }
  const code = detail?.cause?.code;
  if (code && /^(?:ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|CERT_[A-Z_]+|ERR_TLS_[A-Z_]+|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/.test(code)) {
    return new CliError(`Could not connect to ${target.the} (${code})`, 4);
  }
  return new CliError(`Could not connect to ${target.the} or complete the request`, 4);
}

// Shell completion (completion.ts) must offer every option here; the tests check it.
export const OPTIONS = {
  url: { type: 'string' }, server: { type: 'string' }, profile: { type: 'string' },
  'key-stdin': { type: 'boolean' }, filter: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  args: { type: 'string' }, yes: { type: 'boolean' }, json: { type: 'boolean' },
  timeout: { type: 'string' }, data: { type: 'string' }, management: { type: 'boolean' },
  list: { type: 'boolean' }, browser: { type: 'boolean' }, scope: { type: 'string' },
  version: { type: 'boolean', short: 'v' },
} as const;

/** The CLI's own version, from the package.json shipped next to dist/. */
function cliVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('../package.json') as { version?: string }).version ?? 'unknown';
  } catch { return 'unknown'; }
}

// Render the generated catalogue of management API operations, optionally
// filtered to one resource, for `amcp api --list`.
function listOperations(filter: string | undefined, json: boolean): void {
  const ops = filter
    ? OPERATIONS.filter((o) => o.resource === filter || o.resource.startsWith(`${filter}/`))
    : OPERATIONS;
  if (json) { process.stdout.write(`${JSON.stringify({ operations: ops })}\n`); return; }
  if (ops.length === 0) { process.stdout.write(`No operations match "${singleLine(filter ?? '')}"\n`); return; }
  let current = '';
  for (const o of ops) {
    if (o.resource !== current) { current = o.resource; process.stdout.write(`\n${current}\n`); }
    const flags = [o.admin ? 'admin' : '', o.hasBody ? 'body' : ''].filter(Boolean).join(',');
    const tail = o.summary ? `  — ${terminalText(o.summary)}` : '';
    process.stdout.write(`  ${o.method.padEnd(6)} ${o.path}${flags ? ` [${flags}]` : ''}${tail}\n`);
  }
}

function usage(): string {
  return `Usage:
  amcp login --url <instance-url> --server <server-id> [--key-stdin] [--profile <name>]
  amcp login --management --url <instance-url> [--key-stdin] [--profile <name>]
  amcp login --browser --url <instance-url> [--scope read|admin] [--profile <name>]
  amcp logout [--profile <name>]
  amcp whoami [--profile <name>]
  amcp tools ls [--filter <text>] [--profile <name>]
  amcp tools describe <name> [--profile <name>]
  amcp tools call <name> [--args '<json>' | --args @file.json | --args -] [--yes] [--timeout <seconds>]
  amcp api <GET|POST|PUT|PATCH|DELETE> <path> [--data '<json>' | --data @file.json | --data -] [--yes] [--url <instance-url>]
  amcp api --list [<resource>]
  amcp completion <bash|zsh|fish>
  amcp --version

Use --json for machine-readable output. For CI, set AMCP_URL, AMCP_SERVER and AMCP_API_KEY.
The key is never accepted as a command argument. 'amcp api' calls the management
API (/api/*) with a management-scoped key from AMCP_API_KEY or --key-stdin.`;
}

export async function run(args = process.argv.slice(2)): Promise<number> {
  let json = args.includes('--json');
  try {
    const { values, positionals } = parseArgs({
      args,
      options: OPTIONS,
      allowPositionals: true,
    });
    json = values.json === true;
    if (values.version) {
      const version = cliVersion();
      print({ version }, json, () => process.stdout.write(`amcp ${version}\n`));
      return 0;
    }
    if (values.help || positionals.length === 0) {
      print({ usage: usage() }, json, () => process.stdout.write(usage() + '\n'));
      return 0;
    }
    const [command, subcommand] = positionals;
    if (command === 'completion') {
      if (positionals.length !== 2 || !isShell(subcommand)) {
        throw new CliError('Usage: amcp completion <bash|zsh|fish>', 2);
      }
      // A shell sources this output, so it stays plain text even with --json.
      process.stdout.write(completionScript(subcommand));
      return 0;
    }
    let name: string;
    try { name = profileName(values.profile || 'default'); }
    catch { throw new CliError('Invalid profile name', 2); }
    const timeoutSeconds = values.timeout === undefined ? 300 : Number(values.timeout);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 2147483.647 ||
        (values.timeout !== undefined && !/^\d+(?:\.\d+)?$/.test(values.timeout))) {
      throw new CliError('--timeout must be a positive number of seconds (at most 2147483.647)', 2);
    }
    if (values.timeout !== undefined && (command !== 'tools' || subcommand !== 'call')) {
      throw new CliError('--timeout is supported only for tools call', 2);
    }
    const toolCommand = command === 'tools' && ['ls', 'describe', 'call'].includes(subcommand);
    // Complete environment/flag credentials do not depend on a local profile.
    const hasConnection = (values.url || process.env.AMCP_URL) &&
      (values.server || process.env.AMCP_SERVER) && process.env.AMCP_API_KEY;
    const config = toolCommand && hasConnection
      ? { profiles: {} as Record<string, Profile> } : await readConfig();
    if (command === 'login' && values.browser && positionals.length === 1) {
      // Browser login mints a management key through the dashboard session and
      // delivers it over a 127.0.0.1 loopback (see browser-auth.ts). It adds to
      // the key-based logins below; it does not change how they work.
      const url = values.url || process.env.AMCP_URL || config.profiles[name]?.url;
      if (!url) throw new CliError('browser login requires --url', 2);
      let origin: string;
      try { origin = new URL(url).origin; } catch { throw new CliError('Invalid --url', 2); }
      const scopeArg: ManagementScopeArg = (values.scope ?? 'read') as ManagementScopeArg;
      if (scopeArg !== 'read' && scopeArg !== 'admin') {
        throw new CliError("--scope must be 'read' or 'admin'", 2);
      }
      let auth;
      try {
        auth = await browserAuthorize({
          instanceUrl: url, instanceOrigin: origin, scope: scopeArg, label: `amcp CLI (${hostname()})`,
          onUrl: (u, code) => {
            if (json) return;
            process.stderr.write('Opening your browser to authorize the amcp CLI…\n');
            process.stderr.write(`If it does not open, visit:\n  ${u}\n`);
            process.stderr.write(`Verification code: ${code} — it must match the page before you approve.\n`);
          },
        });
      } catch (error) {
        throw new CliError(error instanceof Error ? error.message : 'Browser authorization failed', 3);
      }
      // Verify the minted key reaches the management API before saving it.
      let result;
      try { result = await apiRequest({ url, key: auth.key, method: 'GET', path: '/api/users/me' }); }
      catch (error) { throw classifyConnectionError(error, 'management'); }
      if (result.status === 401 || result.status === 403) {
        throw new CliError('Authentication failed (401/403)', 3);
      }
      if (!result.ok) throw new CliError(`Management API returned HTTP ${result.status}`, 4);
      const profile = withManagementKey(config.profiles[name], url, auth.key);
      config.profiles[name] = profile;
      await writeConfig(config);
      print({ loggedIn: true, profile: name, url: instanceUrl(profile), management: true, browser: true }, json,
        () => process.stdout.write(`Logged in to ${origin} (management, profile: ${name}).\n`));
      return 0;
    }
    if (command === 'login' && values.management && positionals.length === 1) {
      const url = values.url || process.env.AMCP_URL;
      if (!url) throw new CliError('management login requires --url', 2);
      const key = values['key-stdin']
        ? await readKey(process.stdin, process.stderr, true)
        : process.env.AMCP_API_KEY || await readKey(process.stdin, process.stderr, false);
      // Verify the key reaches the management API before saving it.
      let result;
      try { result = await apiRequest({ url, key, method: 'GET', path: '/api/users/me' }); }
      catch (error) { throw classifyConnectionError(error, 'management'); }
      if (result.status === 401 || result.status === 403) {
        throw new CliError('Authentication failed (401/403)', 3);
      }
      if (!result.ok) throw new CliError(`Management API returned HTTP ${result.status}`, 4);
      const profile = withManagementKey(config.profiles[name], url, key);
      config.profiles[name] = profile;
      await writeConfig(config);
      print({ loggedIn: true, profile: name, url: instanceUrl(profile), management: true }, json,
        () => process.stdout.write(`Logged in to ${new URL(url).origin} (management, profile: ${name}).\n`));
      return 0;
    }
    if (command === 'login' && positionals.length === 1) {
      const url = values.url || process.env.AMCP_URL;
      const server = values.server || process.env.AMCP_SERVER;
      if (!url || !server) throw new CliError('login requires --url and --server', 2);
      const profile: Profile = {
        url, server,
        key: values['key-stdin'] ? await readKey(process.stdin, process.stderr, true)
          : process.env.AMCP_API_KEY || await readKey(process.stdin, process.stderr, false),
      };
      try { serverUrl(profile); } catch (error) {
        throw new CliError(error instanceof Error ? error.message : 'Invalid instance URL or server ID', 2);
      }
      try { await listTools(profile); } catch (error) { throw classifyConnectionError(error); }
      // An MCP login keeps a management key already saved for the same instance.
      const previous = config.profiles[name];
      if (previous?.managementKey && previous.url && sameOrigin(url, previous.url)) {
        profile.managementKey = previous.managementKey;
      }
      config.profiles[name] = profile;
      await writeConfig(config);
      print({ loggedIn: true, profile: name, url: instanceUrl(profile), server: profile.server }, json,
        () => process.stdout.write(`Logged in to ${serverUrl(profile).origin} (profile: ${name}).\n`));
      return 0;
    }
    if (command === 'logout' && positionals.length === 1) {
      delete config.profiles[name];
      await writeConfig(config);
      print({ loggedOut: true, profile: name }, json,
        () => process.stdout.write(`Logged out of profile ${name}.\n`));
      return 0;
    }
    const stored = Object.hasOwn(config.profiles, name) ? config.profiles[name] : undefined;
    if (command === 'whoami' && positionals.length === 1) {
      if (!stored) throw new CliError('Profile not found; run amcp login', 2);
      const hint = (k?: string) => k ? (k.startsWith('mcp_') && k.length > 8 ? `${k.slice(0, 8)}…` : '[hidden]') : undefined;
      const hasMcp = !!(stored.server && stored.key);
      const endpoint = hasMcp ? serverUrl(stored).toString() : undefined;
      print(
        { profile: name, url: instanceUrl(stored), endpoint, server: stored.server || undefined,
          key: hint(stored.key), managementKey: hint(stored.managementKey) },
        json,
        () => {
          process.stdout.write(`Profile: ${name}\nURL: ${instanceUrl(stored)}\n`);
          if (hasMcp) process.stdout.write(`MCP endpoint: ${endpoint}\nMCP key: ${hint(stored.key)}\n`);
          if (stored.managementKey) process.stdout.write(`Management key: ${hint(stored.managementKey)}\n`);
        });
      return 0;
    }
    if (command === 'api') {
      // `amcp api --list [resource]`: print the generated catalogue of
      // management operations (no key, no network). Discovery and examples.
      if (values.list) {
        listOperations(positionals[1], json);
        return 0;
      }
      const method = (subcommand || '').toUpperCase();
      const path = positionals[2];
      if (positionals.length !== 3 || !method || !path) {
        throw new CliError('Usage: amcp api <GET|POST|PUT|PATCH|DELETE> <path>', 2);
      }
      if (!(API_METHODS as readonly string[]).includes(method)) {
        throw new CliError(`Unsupported method: ${singleLine(method)}`, 2);
      }
      if (!path.startsWith('/')) throw new CliError('Path must start with /', 2);
      const url = values.url || process.env.AMCP_URL || stored?.url;
      if (!url) throw new CliError('Set --url or AMCP_URL, or log in first', 2);
      // The management key never comes from argv: env or stdin only. A stored
      // profile key is an MCP key and is not used for the management API.
      const key = process.env.AMCP_API_KEY ||
        (values['key-stdin'] ? await readKey(process.stdin, process.stderr, true) : '') ||
        (stored?.managementKey && stored.url && sameOrigin(url, stored.url) ? stored.managementKey : '');
      if (!key) throw new CliError('Set AMCP_API_KEY, pass --key-stdin, or log in with: amcp login --management', 2);
      const safe = method === 'GET' || method === 'HEAD';
      if (safe && values.data !== undefined) {
        throw new CliError(`--data is not allowed with ${method}; put parameters in the path query string`, 2);
      }
      const body = values.data !== undefined ? await readData(values.data) : undefined;
      if (!safe && !values.yes) {
        if (!process.stdin.isTTY) {
          throw new CliError(`${method} may change data; pass --yes in non-interactive mode`, 2);
        }
        if (!await confirmApi(method, path)) throw new CliError('Cancelled', 2);
      }
      let result;
      try {
        result = await apiRequest({ url, key, method: method as ApiMethod, path, body });
      } catch (error) {
        throw classifyConnectionError(error, 'management');
      }
      if (result.status === 401 || result.status === 403) {
        // Keep the server's reason (e.g. "This API key is read-only"): a bare
        // "authentication failed" reads as if the key itself were broken.
        const reason = serverMessage(result.data);
        const label = result.status === 401 ? 'Authentication failed' : 'Forbidden';
        throw new CliError(`${label} (${result.status})${reason ? `: ${reason}` : ''}`, 3);
      }
      print({ status: result.status, data: result.data }, json,
        () => process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`));
      return result.ok ? 0 : result.status >= 500 ? 4 : 1;
    }
    if (toolCommand && (subcommand === 'ls' ? positionals.length === 2 : positionals.length === 3)) {
      const urlOverridden = !!(values.url || process.env.AMCP_URL);
      const url = values.url || process.env.AMCP_URL || stored?.url || '';
      const storedKey = stored && !urlOverridden && sameOrigin(url, stored.url)
        ? stored.key : '';
      const profile: Profile = {
        url,
        server: values.server || process.env.AMCP_SERVER || stored?.server || '',
        key: process.env.AMCP_API_KEY || storedKey,
      };
      if (!profile.url || !profile.server || !profile.key) {
        throw new CliError('Log in first, or set AMCP_URL, AMCP_SERVER and AMCP_API_KEY', 2);
      }
      try { serverUrl(profile); } catch (error) {
        throw new CliError(error instanceof Error ? error.message : 'Invalid instance URL or server ID', 2);
      }
      if (subcommand === 'ls') {
        let tools;
        try { tools = await listTools(profile); } catch (error) { throw classifyConnectionError(error); }
        const filter = values.filter?.toLowerCase();
        const selected = filter ? tools.filter((tool) => tool.name.toLowerCase().includes(filter)) : tools;
        print({ tools: selected }, json, () => {
          for (const tool of selected) {
            const hint = tool.annotations?.destructiveHint ? 'destructive' :
              tool.annotations?.readOnlyHint ? 'read-only' : 'unspecified';
            process.stdout.write(`${singleLine(tool.name)}\t${hint}\t${singleLine(tool.description?.split(/\r?\n/)[0] || '')}\n`);
          }
        });
        return 0;
      }
      const toolName = positionals[2];
      if (subcommand === 'describe') {
        let tools;
        try { tools = await listTools(profile); } catch (error) { throw classifyConnectionError(error); }
        const tool = tools.find((entry) => entry.name === toolName);
        if (!tool) throw new CliError(`Tool not found: ${singleLine(toolName)}`, 2);
        print({ tool }, json, () => {
          process.stdout.write(`Name: ${singleLine(tool.name)}\nDescription: ${terminalText(tool.description || '')}\n`);
          process.stdout.write(`Input schema:\n${JSON.stringify(tool.inputSchema, null, 2)}\n`);
        });
        return 0;
      }
      const toolArgs = await readToolArgs(values.args);
      let result;
      try {
        result = await withClient(profile, async (client) => {
          const tool = (await listClientTools(client)).find((entry) => entry.name === toolName);
          if (!tool) throw new CliError(`Tool not found: ${singleLine(toolName)}`, 2);
          if (tool.annotations?.destructiveHint && !values.yes) {
            if (!process.stdin.isTTY) {
              throw new CliError('This tool is marked destructive; pass --yes in non-interactive mode', 2);
            }
            if (!await confirmDestructive(tool.name)) throw new CliError('Cancelled', 2);
          }
          try {
            return await client.callTool({ name: toolName, arguments: toolArgs }, { timeout: timeoutSeconds * 1000 });
          } catch (error) {
            if ((error as { code?: unknown } | null)?.code === 'REQUEST_TIMEOUT') {
              throw new CliError(`Tool call timed out after ${timeoutSeconds}s`, 4);
            }
            throw error;
          }
        });
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw classifyConnectionError(error);
      }
      print({ tool: toolName, result }, json, () => {
        let printed = false;
        const output = result.isError ? process.stderr : process.stdout;
        for (const content of result.content) {
          if (content.type !== 'text') continue;
          const text = terminalText(content.text);
          output.write(text.endsWith('\n') ? text : `${text}\n`);
          printed = true;
        }
        if (!printed) process.stderr.write('No text content; use --json for the full result\n');
      });
      return result.isError ? 1 : 0;
    }
    throw new CliError(usage(), 2);
  } catch (error) {
    const fail = (message: string, code: number) => {
      process.stderr.write(json ? `${JSON.stringify({ error: message, exitCode: code })}\n` : `${message}\n`);
      return code;
    };
    if (error instanceof CliError) return fail(error.message, error.exitCode);
    if (error instanceof TypeError &&
        (error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS_')) {
      return fail(usage(), 2);
    }
    return fail('CLI error; check arguments and configuration permissions', 4);
  }
}

if (require.main === module) {
  void run().then((code) => { process.exitCode = code; });
}
