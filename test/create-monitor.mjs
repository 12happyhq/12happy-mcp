/**
 * create_monitor against a stand-in API on localhost, through a real MCP
 * client: what is sent for a heartbeat, and what the assistant is told.
 * No key or network needed.
 *
 *   npm test
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const requests = [];
const api = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, url: req.url, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url.endsWith('/monitors')) {
      const heartbeat = body.check_type === 'heartbeat';
      res.statusCode = 201;
      res.end(JSON.stringify({ data: {
        id: 'm1',
        check_type: body.check_type ?? 'http',
        target: body.target ?? null,
        heartbeat: heartbeat ? { url: 'https://be.12hpy.com/hb/tok', grace_period_seconds: body.grace_period_seconds ?? 300 } : undefined,
      } }));
      return;
    }
    res.end(JSON.stringify({ data: {} }));
  });
});
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));

const client = new Client({ name: 'test', version: '1' });
await client.connect(new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: { ...process.env, TWELVEHAPPY_API_KEY: 'mon_live_test', TWELVEHAPPY_API_URL: `http://127.0.0.1:${api.address().port}/v1` },
}));
const call = async (args) => {
  const res = await client.callTool({ name: 'create_monitor', arguments: args });
  return { error: res.isError, text: res.content[0].text };
};

// A heartbeat needs no target, sends no regions, and hands back the URL.
let res = await call({ check_type: 'heartbeat', name: 'Nightly backup', interval_seconds: 86400, grace_period_seconds: 3600, regions: ['ams'] });
assert.equal(res.error, undefined, res.text);
const sent = requests.find((r) => r.method === 'POST' && r.url.endsWith('/monitors')).body;
assert.deepEqual(sent, { name: 'Nightly backup', check_type: 'heartbeat', interval_seconds: 86400, grace_period_seconds: 3600 });
const out = JSON.parse(res.text);
assert.deepEqual(out.heartbeat, { url: 'https://be.12hpy.com/hb/tok', curl: 'curl -fsS -m 10 --retry 3 https://be.12hpy.com/hb/tok' });
assert.ok(out.notes.some((n) => n.includes('https://be.12hpy.com/hb/tok')));
// Nothing to check now: no check-now for a heartbeat.
assert.ok(!requests.some((r) => r.url.endsWith('/check-now')));

// Anything else still needs a target, and is told so before any request.
requests.length = 0;
res = await call({ check_type: 'http' });
assert.equal(res.error, true);
assert.match(res.text, /target is required/);
assert.equal(requests.length, 0);

// And a URL still gets its first check at once.
res = await call({ target: 'https://example.com/health' });
assert.equal(res.error, undefined, res.text);
assert.ok(requests.some((r) => r.url.endsWith('/monitors/m1/check-now')));

await client.close();
api.close();
console.log('create_monitor: ok');
