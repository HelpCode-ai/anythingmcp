/**
 * Runs the Worker's fetch handler on plain Node, for hosting the mock next to
 * the AnythingMCP Cloud backend (internal Docker network, no public port).
 *   node dist/server.mjs            listens on $PORT (default 8787)
 */
import http from 'node:http';
import worker from './index';

const PORT = Number(process.env.PORT ?? 8787);

http
  .createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const request = new Request(url, {
      method: req.method,
      headers,
      body: chunks.length && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined,
    });
    const response = await worker.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
    // Request line only, with control characters stripped so a request cannot forge log lines.
    const line = `${req.method} ${req.url}`.replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').slice(0, 300);
    console.log(`${new Date().toISOString()} ${line} ${response.status}`);
  })
  .listen(PORT, () => console.log(`Lumen & Clay demo API on :${PORT}`));
