# 12happy MCP server

Uptime monitoring you can talk to. This [Model Context Protocol](https://modelcontextprotocol.io) server connects [12happy](https://www.12hpy.com/) to Claude, Cursor, VS Code and any other MCP client, so you can ask:

- "Is anything down right now?"
- "Watch https://api.example.com/health every minute and alert the #ops Slack channel."
- "Why did the checkout monitor fail last night, and from which regions?"
- "What was our uptime and p95 response time for the API last month?"
- "Silence alerts for 20 minutes while I deploy."
- "Tell me if the nightly backup stops running."

12happy checks from the US, Europe and Israel, and opens an incident only when a quorum of regions agrees that something is down, so one flaky probe doesn't page you.

## What you need

- A 12happy account. Every plan includes API access: one key on Free, as many as you need on Pro and Agency. [Start free](https://app.12hpy.com/).
- An **API key**: in the [console](https://app.12hpy.com/), open **API keys** and choose **Create key**. Pick the scopes the assistant should have. A key with only the read scopes can't change anything.
- Node.js 20 or later.

## Install

### Claude Code

```bash
claude mcp add 12happy -e TWELVEHAPPY_API_KEY=mon_live_... -- npx -y 12happy-mcp
```

### Claude Desktop

Add this to `claude_desktop_config.json` (Settings → Developer → Edit Config), then restart Claude:

```json
{
  "mcpServers": {
    "12happy": {
      "command": "npx",
      "args": ["-y", "12happy-mcp"],
      "env": { "TWELVEHAPPY_API_KEY": "mon_live_..." }
    }
  }
}
```

### Cursor

Add the same block to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in a project.

### VS Code

Add this to `.vscode/mcp.json`. VS Code asks for the key once and stores it securely:

```json
{
  "inputs": [
    { "type": "promptString", "id": "twelvehappy-key", "description": "12happy API key", "password": true }
  ],
  "servers": {
    "12happy": {
      "command": "npx",
      "args": ["-y", "12happy-mcp"],
      "env": { "TWELVEHAPPY_API_KEY": "${input:twelvehappy-key}" }
    }
  }
}
```

## Tools

| Tool | What it does |
|---|---|
| `get_overview` | Monitors up, down, slow and paused; open incidents; uptime over N days |
| `list_monitors` | All monitors, filterable by status or text |
| `get_monitor` | One monitor's settings and latest results per region |
| `get_uptime_report` | Uptime % and p50/p95/p99 response time for any period or region |
| `list_incidents` | Outages and slowdowns, with cause and confirming regions |
| `list_alert_channels` | Email, Slack, webhook, SMS and other channels, and their health |
| `list_regions` | Where checks can run from |
| `create_monitor` | Watch a URL, keyword, hostname (ping, DNS, SSL certificate) or TCP port, or a cron job by heartbeat: it returns the URL the job calls when it finishes |
| `update_monitor` | Change target, interval, regions, keyword, timeout or slow threshold |
| `pause_monitor` | Pause or resume, keeping history |
| `check_now` | Run a check immediately |
| `delete_monitor` | Delete a monitor and its history (assistants are told to confirm first) |
| `acknowledge_incident` | Take ownership and stop escalation |
| `start_maintenance` | Silence alerts or pause checks for a deploy |
| `set_monitor_alerts` | Choose which channels a monitor alerts, with escalation delays |

Read-only tools are marked as such, and `delete_monitor` is marked destructive, so clients that ask before risky actions will ask.

## Settings

| Variable | |
|---|---|
| `TWELVEHAPPY_API_KEY` | Required. A key from the console's API keys page. |
| `TWELVEHAPPY_ORG` | Optional. Agencies and resellers: the client organization to act on by default. Every tool also takes an `organization` argument. |
| `TWELVEHAPPY_API_URL` | Optional. Defaults to `https://be.12hpy.com/v1`. |

## Security

- The key is sent only to the 12happy API, as a bearer token, and is never logged.
- Scopes are enforced by the API: a key without `monitors:write` gets a clear "missing scope" error rather than a change.
- Revoke a key at any time from the API keys page; it stops working immediately.

## Develop

```bash
npm install
npm run build
npm run inspect          # opens the MCP Inspector
node --env-file=.env test/smoke.mjs <test-organization-id>
```

The API reference is at [be.12hpy.com/docs/api](https://be.12hpy.com/docs/api).

## License

MIT
