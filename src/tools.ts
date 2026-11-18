import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ApiError, type TwelveHappyClient } from './client.js';

/**
 * The tools an assistant gets. They follow what people ask of a monitoring
 * tool in plain words ("is anything down?", "watch this URL", "silence alerts
 * for the deploy") rather than mirroring every endpoint.
 */

type Json = Record<string, any>;

// Heartbeat (cron) monitors are left out until the API evaluates missed beats;
// see 12happy's audit/heartbeat-ssl-check-2026-11-18.md. Add 'heartbeat' back then.
const CHECK_TYPES = ['http', 'keyword', 'tcp', 'ping', 'dns', 'ssl_cert'] as const;

const orgParam = z
  .string()
  .optional()
  .describe('Organization id. Leave out to use your own account; resellers can name a client organization.');

function ok(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] };
}

function fail(error: unknown): CallToolResult {
  const text = error instanceof ApiError ? error.explain() : `Error: ${(error as Error)?.message ?? String(error)}`;
  return { content: [{ type: 'text', text }], isError: true };
}

/** Wrap a handler so API errors reach the model as readable tool errors. */
function run<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };
}

/** The fields worth showing in a list; the full record is one get_monitor away. */
function brief(m: Json) {
  return {
    id: m.id,
    name: m.name,
    check_type: m.check_type,
    target: m.target,
    status: m.is_paused ? 'paused' : m.status,
    interval_seconds: m.schedule?.interval_seconds,
    last_checked_at: m.last_checked_at,
  };
}

function range(days: number | undefined, from?: string, to?: string) {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - (days ?? 7) * 86_400_000);
  const spanDays = (end.getTime() - start.getTime()) / 86_400_000;
  return { from: start.toISOString(), to: end.toISOString(), granularity: spanDays <= 2 ? '1h' : '1d' };
}

export function registerTools(server: McpServer, api: TwelveHappyClient, defaultOrg: string) {
  const org = (id?: string) => encodeURIComponent(id || defaultOrg);

  // ---------------------------------------------------------------- reading

  server.registerTool(
    'get_overview',
    {
      title: 'Account overview',
      description:
        'How the account is doing right now: monitors up, down, degraded and paused, open and unacknowledged incidents, and uptime over the last N days. Start here when asked "is anything down?".',
      inputSchema: {
        days: z.number().int().min(1).max(90).optional().describe('Uptime window in days (default 30).'),
        organization: orgParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ days, organization }: { days?: number; organization?: string }) => {
      const summary = await api.get<{ data: Json }>(`/organizations/${org(organization)}/summary?days=${days ?? 30}`);
      return summary.data;
    }),
  );

  server.registerTool(
    'list_monitors',
    {
      title: 'List monitors',
      description:
        'Every monitor on the account with its current status (up, down, degraded, unknown or paused), check type, target and interval.',
      inputSchema: {
        status: z
          .enum(['up', 'down', 'degraded', 'unknown', 'paused'])
          .optional()
          .describe('Only monitors in this state.'),
        search: z.string().optional().describe('Only monitors whose name or target contains this text.'),
        organization: orgParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ status, search, organization }: { status?: string; search?: string; organization?: string }) => {
      const rows = (await api.all<Json>(`/organizations/${org(organization)}/monitors?per_page=100`)).map(brief);
      const needle = search?.toLowerCase();
      const filtered = rows.filter(
        (m) =>
          (!status || m.status === status) &&
          (!needle || `${m.name ?? ''} ${m.target ?? ''}`.toLowerCase().includes(needle)),
      );
      return { count: filtered.length, monitors: filtered };
    }),
  );

  server.registerTool(
    'get_monitor',
    {
      title: 'Get a monitor',
      description:
        "One monitor's full settings and its most recent check results from each region, including status codes, errors and response times. Use it to explain why a monitor is down.",
      inputSchema: {
        monitor_id: z.string().describe('The monitor id, from list_monitors.'),
        results: z.number().int().min(0).max(100).optional().describe('How many recent results to include (default 10).'),
        failures_only: z.boolean().optional().describe('Only failed checks.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ monitor_id, results, failures_only }: { monitor_id: string; results?: number; failures_only?: boolean }) => {
      const id = encodeURIComponent(monitor_id);
      const limit = results ?? 10;
      const [monitor, recent] = await Promise.all([
        api.get<{ data: Json }>(`/monitors/${id}`),
        limit > 0
          ? api.get<{ data: Json[] }>(`/monitors/${id}/results?limit=${limit}${failures_only ? '&is_up=false' : ''}`)
          : Promise.resolve({ data: [] }),
      ]);
      return {
        monitor: monitor.data,
        recent_results: recent.data.map((r) => ({
          checked_at: r.checked_at,
          region: r.region,
          is_up: r.is_up,
          status_code: r.status_code,
          response_time_ms: r.response_time_ms,
          error: r.error_message ?? r.error_class ?? undefined,
        })),
      };
    }),
  );

  server.registerTool(
    'get_uptime_report',
    {
      title: 'Uptime and response time report',
      description:
        "A monitor's uptime percentage and response times (p50, p95, p99) over a period, in hourly or daily buckets, overall or for one region. Use it for SLA questions and \"was it slow yesterday?\".",
      inputSchema: {
        monitor_id: z.string().describe('The monitor id, from list_monitors.'),
        days: z.number().int().min(1).max(365).optional().describe('Look back this many days (default 7). Ignored when from is given.'),
        from: z.string().optional().describe('Start, ISO 8601 (e.g. 2026-11-01T00:00:00Z).'),
        to: z.string().optional().describe('End, ISO 8601. Defaults to now.'),
        region: z.string().optional().describe('One region code from list_regions, e.g. ams, nyc or tlv. Leave out for all regions.'),
        include_buckets: z.boolean().optional().describe('Include the per-hour or per-day series, not just the totals (default false).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async (a: { monitor_id: string; days?: number; from?: string; to?: string; region?: string; include_buckets?: boolean }) => {
      const r = range(a.days, a.from, a.to);
      const q = new URLSearchParams({ ...r, ...(a.region ? { region: a.region } : {}) }).toString();
      const id = encodeURIComponent(a.monitor_id);
      const [uptime, latency] = await Promise.all([
        api.get<{ data: Json[]; summary: Json }>(`/monitors/${id}/uptime?${q}`),
        api.get<{ data: Json[]; summary: Json }>(`/monitors/${id}/latency?${q}`),
      ]);
      const { histogram, ...latencySummary } = latency.summary ?? {};
      return {
        range: r,
        region: a.region ?? 'all',
        uptime: uptime.summary,
        latency: latencySummary,
        ...(a.include_buckets ? { uptime_buckets: uptime.data, latency_buckets: latency.data } : {}),
      };
    }),
  );

  server.registerTool(
    'list_incidents',
    {
      title: 'List incidents',
      description:
        'Outages and slowdowns, newest first: which monitor, why, which regions confirmed it, when it opened and closed, and whether someone acknowledged it.',
      inputSchema: {
        open_only: z.boolean().optional().describe('Only incidents that are still open.'),
        monitor_id: z.string().optional().describe('Only incidents for this monitor.'),
        limit: z.number().int().min(1).max(200).optional().describe('At most this many (default 20).'),
        organization: orgParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async (a: { open_only?: boolean; monitor_id?: string; limit?: number; organization?: string }) => {
      const limit = a.limit ?? 20;
      // Filtering happens here, so read further than the limit when a filter is set.
      const rows = await api.all<Json>(
        `/organizations/${org(a.organization)}/incidents?per_page=100`,
        a.open_only || a.monitor_id ? 500 : limit,
      );
      const incidents = rows
        .filter((i) => (!a.open_only || !i.closed_at) && (!a.monitor_id || i.monitor_id === a.monitor_id))
        .slice(0, limit)
        .map((i) => ({
          id: i.id,
          monitor: i.monitor ? { id: i.monitor.id, name: i.monitor.name, target: i.monitor.target } : i.monitor_id,
          severity: i.severity,
          status: i.status,
          cause: i.cause,
          cause_detail: i.cause_detail,
          confirming_regions: i.confirming_regions,
          opened_at: i.opened_at,
          closed_at: i.closed_at,
          duration_seconds: i.duration_seconds,
          acknowledged_at: i.acknowledged_at,
        }));
      return { count: incidents.length, incidents };
    }),
  );

  server.registerTool(
    'list_alert_channels',
    {
      title: 'List alert channels',
      description:
        'Where alerts can go (email, Slack, webhook, SMS and so on), whether each one is verified and delivering, and how many monitors use it. Needed for set_monitor_alerts.',
      inputSchema: { organization: orgParam },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ organization }: { organization?: string }) => {
      const rows = await api.all<Json>(`/organizations/${org(organization)}/alert-channels?per_page=100`);
      return rows.map((c) => ({
        id: c.id,
        name: c.name,
        channel_type: c.channel_type,
        destination: c.destination,
        enabled: c.enabled,
        verified: c.verified,
        health: c.health,
        monitor_count: c.monitor_count,
      }));
    }),
  );

  server.registerTool(
    'list_regions',
    {
      title: 'List check regions',
      description: 'The regions monitors can be checked from, with their codes, for create_monitor and get_uptime_report.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async () => (await api.get<{ data: Json[] }>('/regions')).data),
  );

  // ---------------------------------------------------------------- changing

  server.registerTool(
    'create_monitor',
    {
      title: 'Create a monitor',
      description:
        'Start watching a website, API, server or certificate. Only the target is required; sensible defaults cover the rest, and the first check runs immediately. Use check_type keyword with keyword to require text on the page, ssl_cert or dns with a bare hostname, ping with a hostname or IP, and tcp with host:port.',
      inputSchema: {
        target: z.string().describe('What to watch: a URL (https://example.com/health), a hostname, or host:port for TCP.'),
        name: z.string().optional().describe('A display name. Defaults to the target.'),
        check_type: z.enum(CHECK_TYPES).optional().describe('Defaults to http for URLs.'),
        interval_seconds: z
          .number()
          .int()
          .min(10)
          .max(86400)
          .optional()
          .describe("How often to check. The plan sets the minimum (Free 300, Pro 30, Agency 15). Defaults to the plan's default."),
        keyword: z.string().optional().describe('For keyword checks: text that must appear in the response.'),
        keyword_absent: z.boolean().optional().describe('For keyword checks: alert when the keyword IS present instead.'),
        regions: z.array(z.string()).optional().describe('Region codes from list_regions. Leave out for the default set.'),
        expected_status_codes: z.array(z.number().int()).optional().describe('HTTP codes that count as up (default [200]).'),
        alert_channel_ids: z
          .array(z.string())
          .optional()
          .describe('Alert these channels (ids from list_alert_channels) when it goes down. Without this, nobody is alerted.'),
        organization: orgParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run(async (a: {
      target: string;
      name?: string;
      check_type?: string;
      interval_seconds?: number;
      keyword?: string;
      keyword_absent?: boolean;
      regions?: string[];
      expected_status_codes?: number[];
      alert_channel_ids?: string[];
      organization?: string;
    }) => {
      const body: Json = { target: a.target };
      if (a.name) body.name = a.name;
      if (a.check_type) body.check_type = a.check_type;
      else if (a.keyword) body.check_type = 'keyword';
      if (a.interval_seconds) body.interval_seconds = a.interval_seconds;
      if (a.keyword) body.keyword_match = a.keyword;
      if (a.keyword_absent !== undefined) body.keyword_absent = a.keyword_absent;
      if (a.regions?.length) {
        body.region_mode = 'custom';
        body.regions = a.regions;
      }
      if (a.expected_status_codes?.length) body.expected_status_codes = a.expected_status_codes;

      const created = await api.post<{ data: Json }>(`/organizations/${org(a.organization)}/monitors`, body);
      const monitor = created.data;
      const notes: string[] = [];

      if (a.alert_channel_ids?.length) {
        try {
          await api.put(`/monitors/${monitor.id}/routes`, {
            routes: a.alert_channel_ids.map((id) => ({ alert_channel_id: id, delay_seconds: 0, on_severity: 'down' })),
          });
          notes.push(`Alerts go to ${a.alert_channel_ids.length} channel(s).`);
        } catch (e) {
          notes.push(`The monitor was created, but routing alerts failed: ${e instanceof ApiError ? e.explain() : e}`);
        }
      } else if (monitor.check_type !== 'heartbeat') {
        notes.push('No alert channel is routed yet, so nobody will be alerted. Use set_monitor_alerts to add one.');
      }

      if (monitor.check_type !== 'heartbeat') {
        // A new monitor reads "unknown" until its first check; ask for one now.
        await api.post(`/monitors/${monitor.id}/check-now`).catch(() => undefined);
        notes.push('The first check is running now; get_monitor shows the result in a few seconds.');
      }
      return { monitor, notes };
    }),
  );

  server.registerTool(
    'update_monitor',
    {
      title: 'Update a monitor',
      description: "Change a monitor's name, target, interval, regions, keyword, expected status codes or slow threshold. Only the fields given change.",
      inputSchema: {
        monitor_id: z.string().describe('The monitor id, from list_monitors.'),
        name: z.string().optional(),
        target: z.string().optional(),
        interval_seconds: z.number().int().min(10).max(86400).optional(),
        regions: z.array(z.string()).optional().describe('Region codes from list_regions.'),
        keyword: z.string().optional().describe('For keyword checks.'),
        expected_status_codes: z.array(z.number().int()).optional(),
        timeout_ms: z.number().int().min(1000).max(120000).optional(),
        slow_above_ms: z
          .number()
          .int()
          .min(100)
          .max(120000)
          .nullable()
          .optional()
          .describe('Mark the monitor degraded when responses are slower than this; null turns it off.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run(async (a: {
      monitor_id: string;
      name?: string;
      target?: string;
      interval_seconds?: number;
      regions?: string[];
      keyword?: string;
      expected_status_codes?: number[];
      timeout_ms?: number;
      slow_above_ms?: number | null;
    }) => {
      const body: Json = {};
      if (a.name !== undefined) body.name = a.name;
      if (a.target !== undefined) body.target = a.target;
      if (a.interval_seconds !== undefined) body.interval_seconds = a.interval_seconds;
      if (a.regions?.length) {
        body.region_mode = 'custom';
        body.regions = a.regions;
      }
      if (a.keyword !== undefined) body.keyword_match = a.keyword;
      if (a.expected_status_codes?.length) body.expected_status_codes = a.expected_status_codes;
      if (a.timeout_ms !== undefined) body.timeout_ms = a.timeout_ms;
      if (a.slow_above_ms !== undefined) body.degraded_above_ms = a.slow_above_ms;
      if (Object.keys(body).length === 0) throw new Error('Nothing to change: give at least one field.');
      return (await api.patch<{ data: Json }>(`/monitors/${encodeURIComponent(a.monitor_id)}`, body)).data;
    }),
  );

  server.registerTool(
    'pause_monitor',
    {
      title: 'Pause or resume a monitor',
      description: 'Pause a monitor (keeps its history, stops checks and alerts) or resume it.',
      inputSchema: {
        monitor_id: z.string().describe('The monitor id, from list_monitors.'),
        paused: z.boolean().describe('true to pause, false to resume.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ monitor_id, paused }: { monitor_id: string; paused: boolean }) => {
      const res = await api.post<{ data: Json } | undefined>(
        `/monitors/${encodeURIComponent(monitor_id)}/${paused ? 'pause' : 'resume'}`,
      );
      return res?.data ? brief(res.data) : { id: monitor_id, paused };
    }),
  );

  server.registerTool(
    'check_now',
    {
      title: 'Check a monitor now',
      description: 'Run a monitor\'s next check immediately instead of waiting for its interval, for example after fixing a server. Read the result with get_monitor a few seconds later.',
      inputSchema: { monitor_id: z.string().describe('The monitor id, from list_monitors.') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ monitor_id }: { monitor_id: string }) => {
      await api.post(`/monitors/${encodeURIComponent(monitor_id)}/check-now`);
      return { monitor_id, queued: true };
    }),
  );

  server.registerTool(
    'delete_monitor',
    {
      title: 'Delete a monitor',
      description:
        'Permanently delete a monitor with its history and incidents. This cannot be undone; prefer pause_monitor unless the user clearly wants it gone.',
      inputSchema: { monitor_id: z.string().describe('The monitor id, from list_monitors.') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ monitor_id }: { monitor_id: string }) => {
      await api.delete(`/monitors/${encodeURIComponent(monitor_id)}`);
      return { monitor_id, deleted: true };
    }),
  );

  server.registerTool(
    'acknowledge_incident',
    {
      title: 'Acknowledge an incident',
      description: "Take ownership of an open incident, which stops its escalation to the next alert channels. The incident closes by itself when the monitor recovers.",
      inputSchema: { incident_id: z.string().describe('The incident id, from list_incidents.') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ incident_id }: { incident_id: string }) => {
      const res = await api.post<{ data: Json } | undefined>(`/incidents/${encodeURIComponent(incident_id)}/acknowledge`);
      return res?.data ?? { incident_id, acknowledged: true };
    }),
  );

  server.registerTool(
    'start_maintenance',
    {
      title: 'Start a maintenance window',
      description:
        'Silence alerts (or pause checks) for a deploy or planned work, starting now unless a start time is given. Covers every monitor unless monitor_ids is given.',
      inputSchema: {
        duration_minutes: z.number().int().min(1).max(10080).describe('How long the window lasts.'),
        title: z.string().optional().describe('What the work is, e.g. "Deploy v2.4".'),
        monitor_ids: z.array(z.string()).optional().describe('Only these monitors. Leave out for all.'),
        suppress: z
          .enum(['alerts', 'checks'])
          .optional()
          .describe('alerts (default) keeps checking but alerts nobody; checks stops checking altogether.'),
        starts_at: z.string().optional().describe('ISO 8601 start time. Defaults to now.'),
        organization: orgParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run(async (a: { duration_minutes: number; title?: string; monitor_ids?: string[]; suppress?: string; starts_at?: string; organization?: string }) => {
      const body: Json = { duration_minutes: a.duration_minutes };
      if (a.title) body.title = a.title;
      if (a.monitor_ids?.length) body.monitors = a.monitor_ids;
      if (a.suppress) body.suppress = a.suppress;
      if (a.starts_at) body.starts_at = a.starts_at;
      return (await api.post<{ data: Json }>(`/organizations/${org(a.organization)}/maintenance-windows`, body)).data;
    }),
  );

  server.registerTool(
    'set_monitor_alerts',
    {
      title: 'Set who a monitor alerts',
      description:
        'Replace the alert channels a monitor notifies, optionally as an escalation chain (alert Slack at once, SMS after 10 minutes). An empty list alerts nobody.',
      inputSchema: {
        monitor_id: z.string().describe('The monitor id, from list_monitors.'),
        routes: z
          .array(
            z.object({
              alert_channel_id: z.string().describe('From list_alert_channels.'),
              delay_seconds: z.number().int().min(0).max(86400).optional().describe('Wait this long before alerting this channel (default 0).'),
              on: z.enum(['down', 'degraded', 'both']).optional().describe('Alert on outages, slowness or both (default down).'),
            }),
          )
          .max(20),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ monitor_id, routes }: { monitor_id: string; routes: { alert_channel_id: string; delay_seconds?: number; on?: string }[] }) => {
      const res = await api.put<{ data: Json[] }>(`/monitors/${encodeURIComponent(monitor_id)}/routes`, {
        routes: routes.map((r) => ({
          alert_channel_id: r.alert_channel_id,
          delay_seconds: r.delay_seconds ?? 0,
          on_severity: r.on ?? 'down',
        })),
      });
      return res?.data ?? { monitor_id, routes: routes.length };
    }),
  );
}
