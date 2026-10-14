#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readConfig, writeConfig, profileName, type Profile } from './config.js';
import { listTools, serverUrl } from './mcp.js';

class CliError extends Error {
  constructor(message: string, readonly exitCode: number) { super(message); }
}

function sameOrigin(url: string, storedUrl: string): boolean {
  try { return new URL(url).origin === new URL(storedUrl).origin; }
  catch { return false; }
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
  return new CliError('Could not connect to the MCP server or list tools', 4);
}

function usage(): string {
  return `Usage:
  amcp login --url <instance-url> --server <server-id> [--key-stdin] [--profile <name>]
  amcp logout [--profile <name>]
  amcp whoami [--profile <name>]
  amcp tools ls [--filter <text>] [--profile <name>]

For CI, set AMCP_URL, AMCP_SERVER and AMCP_API_KEY. The key is never accepted as a command argument.`;
}

export async function run(args = process.argv.slice(2)): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args,
      options: {
        url: { type: 'string' }, server: { type: 'string' }, profile: { type: 'string' },
        'key-stdin': { type: 'boolean' }, filter: { type: 'string' }, help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    });
    if (values.help || positionals.length === 0) { process.stdout.write(usage() + '\n'); return 0; }
    let name: string;
    try { name = profileName(values.profile || 'default'); }
    catch { throw new CliError('Invalid profile name', 2); }
    const [command, subcommand] = positionals;
    // Complete environment/flag credentials do not depend on a local profile.
    const hasConnection = (values.url || process.env.AMCP_URL) &&
      (values.server || process.env.AMCP_SERVER) && process.env.AMCP_API_KEY;
    const config = command === 'tools' && subcommand === 'ls' && hasConnection
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
      process.stdout.write(`Logged in to ${serverUrl(profile).origin} (profile: ${name}).\n`);
      return 0;
    }
    if (command === 'logout' && positionals.length === 1) {
      delete config.profiles[name];
      await writeConfig(config);
      process.stdout.write(`Logged out of profile ${name}.\n`);
      return 0;
    }
    const stored = Object.hasOwn(config.profiles, name) ? config.profiles[name] : undefined;
    if (command === 'whoami' && positionals.length === 1) {
      if (!stored) throw new CliError('Profile not found; run amcp login', 2);
      const keyHint = stored.key.startsWith('mcp_') && stored.key.length > 8
        ? `${stored.key.slice(0, 8)}…` : '[hidden]';
      process.stdout.write(`Profile: ${name}\nURL: ${serverUrl(stored).toString()}\nKey: ${keyHint}\n`);
      return 0;
    }
    if (command === 'tools' && subcommand === 'ls' && positionals.length === 2) {
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
      let tools;
      try { tools = await listTools(profile); } catch (error) { throw classifyConnectionError(error); }
      const filter = values.filter?.toLowerCase();
      for (const tool of tools) {
        if (filter && !tool.name.toLowerCase().includes(filter)) continue;
        const hint = tool.annotations?.destructiveHint ? 'destructive' :
          tool.annotations?.readOnlyHint ? 'read-only' : 'unspecified';
        const printable = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
        process.stdout.write(`${printable(tool.name)}\t${hint}\t${printable(tool.description?.split(/\r?\n/)[0] || '')}\n`);
      }
      return 0;
    }
    throw new CliError(usage(), 2);
  } catch (error) {
    if (error instanceof CliError) { process.stderr.write(`${error.message}\n`); return error.exitCode; }
    if (error instanceof TypeError &&
        (error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS_')) {
      process.stderr.write(`${usage()}\n`); return 2;
    }
    process.stderr.write('CLI error; check arguments and configuration permissions\n');
    return 4;
  }
}

if (require.main === module) {
  void run().then((code) => { process.exitCode = code; });
}
