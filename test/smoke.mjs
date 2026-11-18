/**
 * End-to-end check against the live API, through a real MCP client.
 *
 *   node --env-file=.env test/smoke.mjs <organization-id>
 *
 * .env holds TWELVEHAPPY_API_KEY (never committed). The organization should be
 * a test workspace: this creates one monitor there, opens a one-minute
 * maintenance window on it, pauses it and deletes it again. The key itself is
 * never printed.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const org = process.argv[2];
if (!org) throw new Error('Usage: node --env-file=.env test/smoke.mjs <organization-id>');

const client = new Client({ name: 'smoke', version: '1' });
await client.connect(
  new StdioClientTransport({ command: 'node', args: ['dist/index.js'], env: { ...process.env } }),
);

let failed = 0;
async function call(name, args = {}, show = (v) => v) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? '';
  if (res.isError) {
    failed++;
    console.log(`✗ ${name}\n  ${text.replace(/\n/g, '\n  ')}`);
    return null;
  }
  const value = JSON.parse(text);
  console.log(`✓ ${name}`, JSON.stringify(show(value)).slice(0, 400));
  return value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { tools } = await client.listTools();
console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(', ')}\n`);

await call('get_overview', { organization: org });
await call('list_regions', {}, (v) => v.map((r) => r.code ?? r.id ?? r));
await call('list_monitors', { organization: org }, (v) => ({ count: v.count, first: v.monitors[0] }));
await call('list_monitors', { organization: org, status: 'down' }, (v) => v.count);
await call('list_incidents', { organization: org, limit: 3 }, (v) => v);
await call('list_alert_channels', { organization: org }, (v) => v.length);

const created = await call(
  'create_monitor',
  { organization: org, target: 'https://www.12hpy.com/', name: 'MCP smoke test', keyword: '12happy', interval_seconds: 300 },
  (v) => ({ id: v.monitor.id, type: v.monitor.check_type, status: v.monitor.status, notes: v.notes }),
);

if (created) {
  const id = created.monitor.id;
  await sleep(12000);
  await call('get_monitor', { monitor_id: id, results: 5 }, (v) => ({ status: v.monitor.status, results: v.recent_results }));
  await call('get_uptime_report', { monitor_id: id, days: 1 }, (v) => ({ uptime: v.uptime, latency: v.latency }));
  await call('update_monitor', { monitor_id: id, name: 'MCP smoke test (renamed)' }, (v) => v.name);
  await call('start_maintenance', { organization: org, duration_minutes: 1, title: 'MCP smoke test', monitor_ids: [id] }, (v) => ({ id: v.id, state: v.state }));
  await call('check_now', { monitor_id: id });
  await call('pause_monitor', { monitor_id: id, paused: true });
  await call('delete_monitor', { monitor_id: id });
}

// An error path, to see what the model is told.
await call('get_monitor', { monitor_id: '00000000-0000-0000-0000-000000000000' });
failed--; // that one is expected to fail

await client.close();
console.log(failed === 0 ? '\nAll calls behaved.' : `\n${failed} unexpected failure(s).`);
process.exit(failed === 0 ? 0 : 1);
