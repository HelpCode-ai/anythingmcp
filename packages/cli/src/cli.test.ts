import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('login verifies MCP tools and saves a private profile; tools ls and whoami hide the key', async () => {
  const requests: { path: string; key: string | undefined }[] = [];
  const server = createServer(async (req, res) => {
    requests.push({ path: req.url || '', key: req.headers['x-api-key'] as string | undefined });
    if (req.headers['x-api-key'] !== 'mcp_secret-test') { res.writeHead(401); res.end(); return; }
    if (req.method === 'GET') { res.writeHead(405); res.end(); return; }
    if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const message = JSON.parse(body);
    if (message.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } }
      : { tools: [{ name: 'find_customer', description: 'Find a customer\nDetails', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing address');
    const directory = await mkdtemp(join(tmpdir(), 'amcp-cli-test-'));
    const env = { ...process.env, XDG_CONFIG_HOME: directory, AMCP_API_KEY: 'mcp_secret-test' };
    const cli = join(__dirname, 'index.js');
    const base = `http://127.0.0.1:${address.port}`;
    const login = await execFileAsync(process.execPath, [cli, 'login', '--url', base, '--server', 'test'], { env });
    assert.match(login.stdout, /Logged in/);
    assert.doesNotMatch(login.stdout + login.stderr, /mcp_secret-test/);
    const path = join(directory, 'amcp', 'config.json');
    const stored = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(stored.profiles.default.key, 'mcp_secret-test');
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
    const listing = await execFileAsync(process.execPath, [cli, 'tools', 'ls'], { env });
    assert.match(listing.stdout, /find_customer\tread-only\tFind a customer/);
    assert.doesNotMatch(listing.stdout + listing.stderr, /mcp_secret-test/);
    const identity = await execFileAsync(process.execPath, [cli, 'whoami'], { env });
    assert.doesNotMatch(identity.stdout + identity.stderr, /mcp_secret-test/);
    const filtered = await execFileAsync(process.execPath, [cli, 'tools', 'ls', '--filter', 'missing'], { env });
    assert.equal(filtered.stdout, '');
    await execFileAsync(process.execPath, [cli, 'logout'], { env });
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).profiles, {});
    assert.ok(requests.every((request) => request.path === '/mcp/test' && request.key === 'mcp_secret-test'));
  } finally {
    server.close();
  }
});

test('bad key is rejected without writing a profile or printing the key', async () => {
  const server = createServer((_req, res) => { res.writeHead(401); res.end(); });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing address');
    const directory = await mkdtemp(join(tmpdir(), 'amcp-cli-denied-'));
    const env = { ...process.env, XDG_CONFIG_HOME: directory, AMCP_API_KEY: 'mcp_bad-secret' };
    await assert.rejects(execFileAsync(process.execPath, [join(__dirname, 'index.js'), 'login', '--url',
      `http://127.0.0.1:${address.port}`, '--server', 'test'], { env }), (error: unknown) => {
      const failure = error as { code: number; stdout: string; stderr: string };
      assert.equal(failure.code, 3);
      assert.doesNotMatch(failure.stdout + failure.stderr, /mcp_bad-secret/);
      return true;
    });
    await assert.rejects(readFile(join(directory, 'amcp', 'config.json')));
  } finally {
    server.close();
  }
});

test('key stdin is accepted and never echoed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amcp-cli-stdin-'));
  const child = spawn(process.execPath, [join(__dirname, 'index.js'), 'login', '--url',
    'http://127.0.0.1:1', '--server', 'test', '--key-stdin'],
  { env: { ...process.env, XDG_CONFIG_HOME: directory, AMCP_API_KEY: 'mcp_ignore-this-env' }, stdio: 'pipe' });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  child.stdin.end('mcp_stdin-secret\n');
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  assert.equal(code, 4); // Unreachable server; key input itself was accepted.
  assert.doesNotMatch(output, /mcp_stdin-secret/);
  assert.doesNotMatch(output, /Use --key-stdin/);
});
