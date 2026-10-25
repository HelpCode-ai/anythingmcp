#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { completionScript, SHELLS } from './completion.js';
import { readConfig, writeConfig, profileName, type Profile } from './config.js';
import { listClientTools, listTools, serverUrl, withClient } from './mcp.js';

class CliError extends Error {
  constructor(message: string, readonly exitCode: number) { super(message); }
}

function sameOrigin(url: string, storedUrl: string): boolean {
  try { return new URL(url).origin === new URL(storedUrl).origin; }
  catch { return false; }
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

function classifyConnectionError(error: unknown): CliError {
  // MCP/HTTP errors may include request details. Do not print their message.
  const message = error instanceof Error ? error.message : '';
  const detail = error as { status?: number; data?: { status?: number }; cause?: { code?: string } } | null;
  const status = detail?.status ?? detail?.data?.status;
  if (status === 401 || status === 403 || /\b(401|403)\b/.test(message) ||
      (error instanceof Error && error.name === 'UnauthorizedError')) {
    return new CliError('Authentication failed (401/403)', 3);
  }
  if (typeof status === 'number' && status >= 400 && status <= 599) {
    return new CliError(`MCP server returned HTTP ${status}`, 4);
  }
  const code = detail?.cause?.code;
  if (code && /^(?:ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|CERT_[A-Z_]+|ERR_TLS_[A-Z_]+|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/.test(code)) {
    return new CliError(`Could not connect to the MCP server (${code})`, 4);
  }
  return new CliError('Could not connect to the MCP server or complete the request', 4);
}

function usage(): string {
  return `Usage:
  amcp login --url <instance-url> --server <server-id> [--key-stdin] [--profile <name>]
  amcp logout [--profile <name>]
  amcp whoami [--profile <name>]
  amcp tools ls [--filter <text>] [--profile <name>]
  amcp tools describe <name> [--profile <name>]
  amcp tools call <name> [--args '<json>' | --args @file.json | --args -] [--yes] [--timeout <seconds>]
  amcp completion <bash|zsh|fish>

Use --json for machine-readable output. For CI, set AMCP_URL, AMCP_SERVER and AMCP_API_KEY.
The key is never accepted as a command argument.`;
}

const OPTIONS = {
  url: { type: 'string' }, server: { type: 'string' }, profile: { type: 'string' },
  'key-stdin': { type: 'boolean' }, filter: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  args: { type: 'string' }, yes: { type: 'boolean' }, json: { type: 'boolean' },
  timeout: { type: 'string' },
} as const;

export async function run(args = process.argv.slice(2)): Promise<number> {
  let json = args.includes('--json');
  try {
    const { values, positionals } = parseArgs({
      args,
      options: OPTIONS,
      allowPositionals: true,
    });
    json = values.json === true;
    if (values.help || positionals.length === 0) {
      print({ usage: usage() }, json, () => process.stdout.write(usage() + '\n'));
      return 0;
    }
    if (positionals[0] === 'completion') {
      const script = positionals.length === 2 ? completionScript(positionals[1], OPTIONS) : undefined;
      if (script === undefined) throw new CliError(`Usage: amcp completion <${SHELLS.join('|')}>`, 2);
      process.stdout.write(script); // plain text even with --json
      return 0;
    }
    let name: string;
    try { name = profileName(values.profile || 'default'); }
    catch { throw new CliError('Invalid profile name', 2); }
    const [command, subcommand] = positionals;
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
      const keyHint = stored.key.startsWith('mcp_') && stored.key.length > 8
        ? `${stored.key.slice(0, 8)}…` : '[hidden]';
      print({ profile: name, url: instanceUrl(stored), endpoint: serverUrl(stored).toString(), server: stored.server, key: keyHint }, json,
        () => process.stdout.write(`Profile: ${name}\nURL: ${serverUrl(stored).toString()}\nKey: ${keyHint}\n`));
      return 0;
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
