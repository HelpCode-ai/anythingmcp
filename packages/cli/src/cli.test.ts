import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { configPath, writeConfig } from './config.js';
import { serverUrl } from './mcp.js';

const execFileAsync = promisify(execFile);

test('SSE calls allow slow tools, honor custom timeouts and paginate tool discovery', async () => {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let calls = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') { res.writeHead(405); res.end(); return; }
    if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const request = JSON.parse(body);
    if (request.id === undefined) { res.writeHead(202); res.end(); return; }
    let result: unknown;
    if (request.method === 'initialize') {
      result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'sse-fake', version: '1' } };
    } else if (request.method === 'tools/list') {
      result = request.params?.cursor === 'next'
        ? { tools: [{ name: 'slow', inputSchema: { type: 'object' } }] }
        : { tools: [{ name: 'first', inputSchema: { type: 'object' } }], nextCursor: 'next' };
    } else if (request.method === 'tools/call') {
      calls++;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { timers.delete(timer); resolve(); }, request.params.arguments.delayMs ?? 65000);
        timers.add(timer);
        res.once('close', () => { clearTimeout(timer); timers.delete(timer); resolve(); });
      });
      if (res.destroyed) return;
      result = { content: [{ type: 'text', text: 'Slow tool completed' }] };
    } else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n\n`);
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing address');
    const env = { ...process.env, AMCP_URL: `http://127.0.0.1:${address.port}`,
      AMCP_SERVER: 'test', AMCP_API_KEY: 'mcp_sse-secret' };
    const run = (args: string[]) => execFileAsync(process.execPath, [join(__dirname, 'index.js'), ...args], { env });
    const listing = JSON.parse((await run(['tools', 'ls', '--json'])).stdout);
    assert.deepEqual(listing.tools.map((tool: { name: string }) => tool.name), ['first', 'slow']);
    for (const timeout of ['0', '-1', 'NaN', 'Infinity', '', '2147484']) {
      await assert.rejects(run(['tools', 'call', 'slow', '--timeout', timeout, '--json']), (error: unknown) => {
        const failure = error as { code: number; stderr: string };
        assert.equal(failure.code, 2);
        assert.match(JSON.parse(failure.stderr).error, /--timeout/);
        return true;
      });
    }
    assert.equal(calls, 0);
    await assert.rejects(run(['tools', 'call', 'slow', '--timeout', '0.1', '--args', '{"delayMs":1000}', '--json']), (error: unknown) => {
      const failure = error as { code: number; stdout: string; stderr: string };
      assert.equal(failure.code, 4);
      assert.equal(failure.stdout, '');
      assert.deepEqual(JSON.parse(failure.stderr), { error: 'Tool call timed out after 0.1s', exitCode: 4 });
      assert.doesNotMatch(failure.stderr, /mcp_sse-secret/);
      return true;
    });
    assert.equal((await run(['tools', 'call', 'slow', '--timeout', '2', '--args', '{"delayMs":100}'])).stdout, 'Slow tool completed\n');
    // A real 65-second response catches regression to the SDK's 60-second default.
    assert.equal((await run(['tools', 'call', 'slow'])).stdout, 'Slow tool completed\n');
  } finally {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('login verifies MCP tools and saves a private profile; tools ls and whoami hide the key', async () => {
  const requests: { method: string | undefined; path: string; key: string | undefined }[] = [];
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, path: req.url || '', key: req.headers['x-api-key'] as string | undefined });
    if (req.headers['x-api-key'] !== 'mcp_secret-test') { res.writeHead(401); res.end(); return; }
    if (req.method === 'GET') { res.writeHead(405); res.end(); return; }
    if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const message = JSON.parse(body);
    if (message.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } }
      : { tools: [
        { name: 'find_customer', description: 'Find a customer\nDetails', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
        { name: 'evil\rforged', description: 'untrusted\ttext\u001b[31m', inputSchema: { type: 'object', properties: {} } },
      ] };
    res.writeHead(200, { 'Content-Type': 'application/json', ...(message.method === 'initialize'
      ? { 'Mcp-Session-Id': 'cli-test-session' } : {}) });
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
    const storedEnv: NodeJS.ProcessEnv = { ...env };
    delete storedEnv.AMCP_API_KEY;
    delete storedEnv.AMCP_URL;
    const listing = await execFileAsync(process.execPath, [cli, 'tools', 'ls'], { env: storedEnv });
    assert.match(listing.stdout, /find_customer\tread-only\tFind a customer/);
    assert.match(listing.stdout, /evil forged\tunspecified\tuntrusted text \[31m/);
    assert.doesNotMatch(listing.stdout, /\u001b|\r/);
    assert.doesNotMatch(listing.stdout + listing.stderr, /mcp_secret-test/);
    const identity = await execFileAsync(process.execPath, [cli, 'whoami'], { env });
    assert.doesNotMatch(identity.stdout + identity.stderr, /mcp_secret-test/);
    const filtered = await execFileAsync(process.execPath, [cli, 'tools', 'ls', '--filter', 'missing'], { env: storedEnv });
    assert.equal(filtered.stdout, '');
    await execFileAsync(process.execPath, [cli, 'logout'], { env });
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).profiles, {});
    assert.ok(requests.every((request) => request.path === '/mcp/test' && request.key === 'mcp_secret-test'));
    assert.ok(requests.some((request) => request.method === 'DELETE'), 'sessions must be terminated remotely');
    await writeFile(path, 'corrupt config');
    const envOnly = await execFileAsync(process.execPath, [cli, 'tools', 'ls'], {
      env: { ...env, AMCP_URL: base, AMCP_SERVER: 'test' },
    });
    assert.match(envOnly.stdout, /find_customer/);
  } finally {
    server.close();
  }
});

test('HTTP is limited to loopback addresses', () => {
  for (const host of ['localhost', '127.0.0.1', '127.8.9.10', '[::1]']) {
    assert.equal(serverUrl({ url: `http://${host}:4000`, server: 'test' }).pathname, '/mcp/test');
  }
  for (const host of ['192.168.1.10', 'example.com', '[::2]']) {
    assert.throws(() => serverUrl({ url: `http://${host}:4000`, server: 'test' }), /HTTP is allowed only/);
  }
});

test('relative XDG_CONFIG_HOME is ignored', () => {
  assert.equal(configPath({ XDG_CONFIG_HOME: 'relative/path' }), configPath({}));
});

test('invalid arguments return usage exit code 2', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amcp-usage-'));
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: directory };
  delete env.AMCP_URL;
  delete env.AMCP_API_KEY;
  for (const args of [
    ['whoami', '--profile', '!invalid'],
    ['login', '--url'],
  ]) {
    await assert.rejects(execFileAsync(process.execPath, [join(__dirname, 'index.js'), ...args], { env }),
      (error: unknown) => {
        assert.equal((error as { code: number }).code, 2);
        return true;
      });
  }
});

test('redirects never forward an API key to another server', async () => {
  const received: Array<string | undefined> = [];
  const target = createServer((req, res) => {
    received.push(req.headers['x-api-key'] as string | undefined);
    res.writeHead(200); res.end();
  });
  target.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => target.once('listening', resolve));
  const targetAddress = target.address();
  if (!targetAddress || typeof targetAddress === 'string') throw new Error('Missing target address');
  const redirect = createServer((_req, res) => {
    res.writeHead(307, { Location: `http://127.0.0.1:${targetAddress.port}/capture` }); res.end();
  });
  redirect.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => redirect.once('listening', resolve));
  try {
    const address = redirect.address();
    if (!address || typeof address === 'string') throw new Error('Missing redirect address');
    const directory = await mkdtemp(join(tmpdir(), 'amcp-redirect-'));
    await assert.rejects(execFileAsync(process.execPath, [join(__dirname, 'index.js'), 'login',
      '--url', `http://127.0.0.1:${address.port}`, '--server', 'test'], {
      env: { ...process.env, XDG_CONFIG_HOME: directory, AMCP_API_KEY: 'mcp_redirect-secret' },
    }), (error: unknown) => {
      assert.equal((error as { code: number }).code, 4);
      return true;
    });
    assert.deepEqual(received, []);
  } finally {
    redirect.close(); target.close();
  }
});

test('URL overrides require an explicit environment key', async () => {
  const received: Array<string | undefined> = [];
  const target = createServer((req, res) => {
    received.push(req.headers['x-api-key'] as string | undefined);
    res.writeHead(401); res.end();
  });
  target.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => target.once('listening', resolve));
  try {
    const address = target.address();
    if (!address || typeof address === 'string') throw new Error('Missing address');
    const directory = await mkdtemp(join(tmpdir(), 'amcp-override-'));
    await writeConfig({ profiles: { default: {
      url: 'https://original.example', server: 'test', key: 'mcp_stored-secret',
    } } }, join(directory, 'amcp', 'config.json'));
    const baseEnv: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: directory };
    delete baseEnv.AMCP_API_KEY;
    delete baseEnv.AMCP_URL;
    const url = `http://127.0.0.1:${address.port}`;
    for (const [extraArgs, extraEnv] of [
      [['--url', url], {}],
      [[], { AMCP_URL: url }],
    ] as const) {
      for (const command of [['tools', 'ls'], ['tools', 'describe', 'x'], ['tools', 'call', 'x']]) {
        await assert.rejects(execFileAsync(process.execPath,
          [join(__dirname, 'index.js'), ...command, ...extraArgs],
          { env: { ...baseEnv, ...extraEnv } }), (error: unknown) => {
          assert.equal((error as { code: number }).code, 2);
          return true;
        });
      }
    }
    assert.deepEqual(received, []);
  } finally { target.close(); }
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

test('server failures report only the HTTP status', async () => {
  const server = createServer((_req, res) => { res.writeHead(503); res.end('sensitive upstream text'); });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing address');
    const directory = await mkdtemp(join(tmpdir(), 'amcp-503-'));
    await assert.rejects(execFileAsync(process.execPath, [join(__dirname, 'index.js'), 'login', '--url',
      `http://127.0.0.1:${address.port}`, '--server', 'test'], {
      env: { ...process.env, XDG_CONFIG_HOME: directory, AMCP_API_KEY: 'mcp_status-secret' },
    }), (error: unknown) => {
      const failure = error as { code: number; stderr: string };
      assert.equal(failure.code, 4);
      assert.match(failure.stderr, /HTTP 503/);
      assert.doesNotMatch(failure.stderr, /sensitive upstream text|mcp_status-secret/);
      return true;
    });
  } finally { server.close(); }
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

test('tools describe and call support JSON, files, stdin, failures and destructive hints', async () => {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const tools = [
    { name: 'echo', description: 'Echo the input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true } },
    { name: 'fail', description: 'Return a tool error', inputSchema: { type: 'object', properties: {} } },
    { name: 'delete_record', description: 'Delete a record', inputSchema: { type: 'object', properties: {} }, annotations: { destructiveHint: true } },
  ];
  const server = createServer(async (req, res) => {
    if (req.headers['x-api-key'] !== 'mcp_tool-secret') { res.writeHead(401); res.end(); return; }
    if (req.method === 'GET') { res.writeHead(405); res.end(); return; }
    if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const request = JSON.parse(body);
    if (request.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    let result: unknown;
    if (request.method === 'initialize') {
      result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } };
    } else if (request.method === 'tools/list') {
      result = { tools };
    } else if (request.method === 'tools/call') {
      calls.push(request.params);
      result = { content: [{ type: 'text', text: request.params.name === 'fail' ? 'Tool failed' : 'Echo\u001b[31m result' }],
        isError: request.params.name === 'fail' };
    } else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', ...(request.method === 'initialize'
      ? { 'Mcp-Session-Id': 'cli-call-session' } : {}) });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing address');
    const directory = await mkdtemp(join(tmpdir(), 'amcp-call-'));
    const env = { ...process.env, XDG_CONFIG_HOME: directory, AMCP_URL: `http://127.0.0.1:${address.port}`,
      AMCP_SERVER: 'test', AMCP_API_KEY: 'mcp_tool-secret' };
    const cli = join(__dirname, 'index.js');
    const run = (args: string[]) => execFileAsync(process.execPath, [cli, ...args], { env });

    const login = JSON.parse((await run(['login', '--json'])).stdout);
    assert.deepEqual(login, { loggedIn: true, profile: 'default', url: env.AMCP_URL, server: 'test' });
    const whoami = JSON.parse((await run(['whoami', '--json'])).stdout);
    assert.equal(whoami.server, 'test');
    assert.equal(whoami.url, login.url);
    assert.equal(whoami.endpoint, `${env.AMCP_URL}/mcp/test`);
    assert.doesNotMatch(JSON.stringify(whoami), /mcp_tool-secret/);
    const prefixedLogin = JSON.parse((await run(['login', '--url', `${env.AMCP_URL}/gateway/`, '--profile', 'prefix', '--json'])).stdout);
    const prefixedWhoami = JSON.parse((await run(['whoami', '--profile', 'prefix', '--json'])).stdout);
    assert.equal(prefixedLogin.url, `${env.AMCP_URL}/gateway`);
    assert.equal(prefixedWhoami.url, prefixedLogin.url);
    assert.equal(prefixedWhoami.endpoint, `${env.AMCP_URL}/gateway/mcp/test`);
    const listing = JSON.parse((await run(['tools', 'ls', '--json'])).stdout);
    assert.deepEqual(listing.tools.map((tool: { name: string }) => tool.name), ['echo', 'fail', 'delete_record']);
    const described = JSON.parse((await run(['tools', 'describe', 'echo', '--json'])).stdout);
    assert.equal(described.tool.inputSchema.properties.text.type, 'string');
    assert.match((await run(['tools', 'describe', 'echo'])).stdout, /Input schema:/);

    const inline = JSON.parse((await run(['tools', 'call', 'echo', '--args', '{"text":"inline"}', '--json'])).stdout);
    assert.equal(inline.result.content[0].text, 'Echo\u001b[31m result');
    assert.deepEqual(calls.at(-1), { name: 'echo', arguments: { text: 'inline' } });
    assert.equal((await run(['tools', 'call', 'echo'])).stdout, 'Echo [31m result\n');
    assert.deepEqual(calls.at(-1), { name: 'echo', arguments: {} });

    const argsFile = join(directory, 'args.json');
    await writeFile(argsFile, '{"text":"file"}');
    await run(['tools', 'call', 'echo', '--args', `@${argsFile}`]);
    assert.deepEqual(calls.at(-1), { name: 'echo', arguments: { text: 'file' } });

    const child = spawn(process.execPath, [cli, 'tools', 'call', 'echo', '--args', '-', '--json'],
      { env, stdio: 'pipe' });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stdin.end('{"text":"stdin"}');
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).tool, 'echo');
    assert.deepEqual(calls.at(-1), { name: 'echo', arguments: { text: 'stdin' } });

    const beforeErrors = calls.length;
    for (const input of ['{broken', '[]', 'null']) {
      await assert.rejects(run(['tools', 'call', 'echo', '--args', input, '--json']), (error: unknown) => {
        const failure = error as { code: number; stderr: string };
        assert.equal(failure.code, 2);
        assert.equal(JSON.parse(failure.stderr).exitCode, 2);
        assert.doesNotMatch(failure.stderr, /mcp_tool-secret/);
        return true;
      });
    }
    assert.equal(calls.length, beforeErrors);
    await assert.rejects(run(['tools', 'call', 'echo', '--args', '@missing.json']), (error: unknown) => {
      assert.equal((error as { code: number }).code, 2);
      return true;
    });
    await assert.rejects(run(['tools', 'describe', 'missing']), (error: unknown) => {
      assert.equal((error as { code: number }).code, 2);
      return true;
    });
    assert.equal(calls.length, beforeErrors);
    await assert.rejects(run(['tools', 'call', 'delete_record']), (error: unknown) => {
      assert.equal((error as { code: number }).code, 2);
      return true;
    });
    assert.equal(calls.length, beforeErrors);
    await run(['tools', 'call', 'delete_record', '--yes']);
    assert.equal(calls.at(-1)?.name, 'delete_record');

    await assert.rejects(run(['tools', 'call', 'fail', '--json']), (error: unknown) => {
      const failure = error as { code: number; stdout: string };
      assert.equal(failure.code, 1);
      assert.equal(JSON.parse(failure.stdout).result.isError, true);
      return true;
    });
    await assert.rejects(run(['tools', 'call', 'fail']), (error: unknown) => {
      const failure = error as { code: number; stdout: string; stderr: string };
      assert.equal(failure.code, 1);
      assert.equal(failure.stdout, '');
      assert.match(failure.stderr, /Tool failed/);
      return true;
    });
    assert.deepEqual(JSON.parse((await run(['logout', '--json'])).stdout),
      { loggedOut: true, profile: 'default' });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
