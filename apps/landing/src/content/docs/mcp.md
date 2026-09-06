---
title: "Maple MCP server"
description: "Connect Claude, Cursor, and other AI agents to your Maple telemetry over the Model Context Protocol — endpoint, authentication, manifest, and the tools it exposes."
group: "Reference"
order: 2
---

Maple ships a hosted **Model Context Protocol (MCP)** server, so an AI agent can investigate your production telemetry the way an engineer would: list services, search traces and logs, find and triage error issues, inspect dashboards, and create or update alert rules — all against your real data and scoped to your organisation.

|                          |                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Endpoint                 | `https://api.maple.dev/mcp`                                                                                                                |
| Transport                | Streamable HTTP                                                                                                                            |
| Manifest (`server.json`) | [maple.dev/.well-known/mcp.json](/.well-known/mcp.json) · [api.maple.dev/.well-known/mcp.json](https://api.maple.dev/.well-known/mcp.json) |
| Registry name            | `dev.maple/maple`                                                                                                                          |
| Auth                     | Maple API key as Bearer token, or OAuth 2.1                                                                                                |

## Connecting a client

Any MCP client that speaks Streamable HTTP can connect. Two authentication options:

**API key.** Create a key under **Settings → API keys** in the dashboard and pass it as a Bearer token:

```json
{
	"mcpServers": {
		"maple": {
			"type": "http",
			"url": "https://api.maple.dev/mcp",
			"headers": { "Authorization": "Bearer maple_ak_…" }
		}
	}
}
```

For Claude Code: `claude mcp add --transport http maple https://api.maple.dev/mcp --header "Authorization: Bearer maple_ak_…"`.

**OAuth.** Clients that support the MCP authorization flow need no key at all. The server advertises its protected-resource metadata at `https://api.maple.dev/.well-known/oauth-protected-resource/mcp` and its authorization server at `https://api.maple.dev/.well-known/oauth-authorization-server`; dynamic client registration and PKCE (`S256`) are supported, so a conforming client discovers everything from the endpoint URL alone and opens a browser sign-in on first use.

Requests are scoped to the organisation the key or the signed-in user belongs to. A user in several organisations selects one during the OAuth consent step.

## What the server exposes

The tool set mirrors the [Maple API](/docs/api) and the dashboard. Broadly:

- **Discovery** — `list_services`, `service_map`, `get_service_top_operations`, `list_metrics`, `explore_attributes`, `describe_warehouse_tables`
- **Traces and logs** — `search_traces`, `find_slow_traces`, `inspect_trace`, `inspect_span`, `search_logs`, `mine_log_patterns`, `query_data`, `run_sql`
- **Errors and incidents** — `find_errors`, `list_error_issues`, `error_detail`, `list_error_issue_events`, `get_incident_timeline`, `diagnose_service`, `compare_periods`, plus triage actions (`claim_error_issue`, `transition_error_issue`, `set_issue_severity`, `comment_on_error_issue`, `propose_fix`)
- **Sessions** — `search_sessions`, `get_session_traces`, `get_session_transcript`
- **Dashboards** — `list_dashboards`, `get_dashboard`, `create_dashboard`, `add_dashboard_widget`, `update_dashboard_widget`, `inspect_chart_data`, `describe_dashboard_schema`
- **Alerting** — `list_alert_rules`, `get_alert_rule`, `create_alert_rule`, `update_alert_rule`, `delete_alert_rule`, `list_alert_incidents`, `list_alert_checks`
- **Setup** — `audit_setup`, `get_instrumentation_recommendations`, `register_agent`

The server also ships prompts for common investigations (incident triage, latency analysis, debugging errors) and an `instructions` resource that explains Maple's data model to the model. Call `tools/list` for the authoritative, always-current list — the exact set evolves with the product.

## Related

- [Maple API](/docs/api) — the REST surface behind the tools, with its [OpenAPI spec](/openapi.json)
- [AI & MCP feature overview](/features/ai-mcp-integration)
- [llms.txt](/llms.txt) — the machine-readable index of this site
