#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readConfig, writeConfig, profileName, type Profile } from './config.js';
import { listTools, serverUrl } from './mcp.js';

class CliError extends Error {
  constructor(message: string, readonly exitCode: number) { super(message); }
}

async function readKey(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, fromStdin: boolean): Promise<string> {
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
  stdout.write('MCP API key: ');
  return new Promise<string>((resolve, reject) => {
    let key = '';
    const cleanup = () => { stdin.setRawMode(false); stdin.pause(); stdout.write('\n'); };
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3 || byte === 4) {
          stdin.off('data', onData); cleanup(); reject(new CliError('Cancelled', 2)); return;
        }
        if (byte === 13 || byte === 10) {
          stdin.off('data', onData); cleanup();
          if (!key) reject(new CliError('API key was empty', 2)); else resolve(key);
          return;
        }
        if (byte === 8 || byte === 127) key = key.slice(0, -1);
        else if (byte >= 32 && byte <= 126) key += String.fromCharCode(byte);
      }
    };
    stdin.on('data', onData);
  });
}

function classifyConnectionError(error: unknown): CliError {
  // MCP/HTTP errors may include request details. Do not print their message.
  const message = error instanceof Error ? error.message : '';
  const status = (error as { data?: { status?: number } } | null)?.data?.status;
  if (status === 401 || status === 403 || /\b(401|403)\b/.test(message) ||
      (error instanceof Error && error.name === 'UnauthorizedError')) {
    return new CliError('Authentication failed (401/403)', 3);
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
    const name = profileName(values.profile || 'default');
    const config = await readConfig();
    const [command, subcommand] = positionals;
    if (command === 'login' && positionals.length === 1) {
      const url = values.url || process.env.AMCP_URL;
      const server = values.server || process.env.AMCP_SERVER;
      if (!url || !server) throw new CliError('login requires --url and --server', 2);
      const profile: Profile = {
        url, server,
        key: values['key-stdin'] ? await readKey(process.stdin, process.stdout, true)
          : process.env.AMCP_API_KEY || await readKey(process.stdin, process.stdout, false),
      };
      try { serverUrl(profile); } catch { throw new CliError('Invalid instance URL or server ID', 2); }
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
      const profile: Profile = {
        url: values.url || process.env.AMCP_URL || stored?.url || '',
        server: values.server || process.env.AMCP_SERVER || stored?.server || '',
        key: process.env.AMCP_API_KEY || stored?.key || '',
      };
      if (!profile.url || !profile.server || !profile.key) {
        throw new CliError('Log in first, or set AMCP_URL, AMCP_SERVER and AMCP_API_KEY', 2);
      }
      try { serverUrl(profile); } catch { throw new CliError('Invalid instance URL or server ID', 2); }
      let tools;
      try { tools = await listTools(profile); } catch (error) { throw classifyConnectionError(error); }
      const filter = values.filter?.toLowerCase();
      for (const tool of tools) {
        if (filter && !tool.name.toLowerCase().includes(filter)) continue;
        const hint = tool.annotations?.destructiveHint ? 'destructive' :
          tool.annotations?.readOnlyHint ? 'read-only' : 'unspecified';
        process.stdout.write(`${tool.name}\t${hint}\t${tool.description?.split(/\r?\n/)[0] || ''}\n`);
      }
      return 0;
    }
    throw new CliError(usage(), 2);
  } catch (error) {
    if (error instanceof CliError) { process.stderr.write(`${error.message}\n`); return error.exitCode; }
    if (error instanceof TypeError && error.message.includes('Unknown option')) {
      process.stderr.write(`${usage()}\n`); return 2;
    }
    process.stderr.write('CLI error; check arguments and configuration permissions\n');
    return 4;
  }
}

if (require.main === module) {
  void run().then((code) => { process.exitCode = code; });
}
