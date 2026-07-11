---
title: "PlanetScale"
description: "Connect a PlanetScale organization to Maple with one OAuth click — Maple discovers every database branch's Prometheus endpoint automatically and scrapes connections, WAL size, and pod CPU."
group: "Integrations"
order: 2
---

PlanetScale publishes per-database-branch Prometheus metrics behind a [service-discovery API](https://planetscale.com/docs/vitess/integrations/prometheus): a single organization endpoint returns the current list of branch metrics targets, which changes as branches are created and destroyed. Maple supports this natively — you connect the **organization** once, and Maple's scrape agent runs the discovery call, scrapes every branch endpoint it returns, and refreshes the branch list automatically (every 10 minutes). No Prometheus server or `remote_write` pipeline needed.

## Connect the organization in Maple

Open **Integrations → PlanetScale** in the Maple dashboard and click **Connect PlanetScale**. A popup takes you to PlanetScale to authorize Maple's OAuth application — no tokens to create or paste, and access can be revoked from PlanetScale at any time.

- If the authorization covers exactly **one** PlanetScale organization, Maple binds it automatically.
- If it covers **several**, pick the one to connect (you can optionally exclude branches by glob, e.g. `pr-*`, at the same time). You can re-bind to a different organization later with **Change organization**.

Maple then provisions the managed scrape target: it derives the discovery URL (`https://api.planetscale.com/v1/organizations/{org}/metrics`), authenticates every discovery call and scrape with the OAuth access token (refreshed automatically), and expands the result into one scrape loop per database branch. New branches start being scraped within a discovery refresh; deleted branches stop cleanly.

The OAuth application needs the organization-level `read_metrics_endpoints` scope (metrics discovery — required) and `read_databases` (database inventory for the service map and Query Insights — recommended).

## What you get

Each discovered branch is scraped as its own instance, labeled with PlanetScale's own discovery labels — most usefully `planetscale_database_branch_id`, which keys every series to a branch. Highlights from the metric set ([Postgres](https://planetscale.com/docs/postgres/monitoring/prometheus-postgres) · [Vitess](https://planetscale.com/docs/vitess/integrations/prometheus)):

| Metric                                         | What it tells you                                         |
| ---------------------------------------------- | --------------------------------------------------------- |
| `planetscale_postgres_connection_state`        | Connections by state (active, idle, idle-in-transaction). |
| `planetscale_edge_postgres_active_connections` | Active connections at the edge.                           |
| `planetscale_postgres_wal_size_bytes`          | WAL size — replication and disk-pressure early warning.   |
| `planetscale_pgbouncer_current_connections`    | PgBouncer pool utilization.                               |
| `planetscale_pods_cpu_util_percentages`        | CPU per pod backing the branch.                           |
| `planetscale_vtgate_total_pods`                | (Vitess) vtgate pods per availability zone.               |

Build dashboards or alert rules grouped by `planetscale_database_branch_id` — e.g. alert when WAL size grows past a threshold or active connections approach your pool limit.

## Manual scrape target (service token)

If you'd rather not authorize the OAuth application, you can still add a PlanetScale scrape target by hand under **Settings → Scrape targets**: create a **service token** in PlanetScale with the `read_metrics_endpoints` organization permission and enter its ID and secret (encrypted at rest, never sent to the browser again). This scrapes branch metrics only — the database inventory, service-map branding, Query Insights, and webhooks come with the OAuth integration.

## Health and troubleshooting

- The target's check history shows per-branch scrape outcomes (each branch is a separate `instance`); a branch-level failure is prefixed `[branch:…]` in the target's error display.
- If discovery itself fails transiently, Maple keeps scraping the last-known branch list and surfaces the discovery error on the target — branch metrics don't blink out because of a control-plane hiccup.
- **401/403 on discovery** — the authorization was revoked or is missing `read_metrics_endpoints`: reconnect from **Integrations → PlanetScale** (for a manual target, regenerate the service token and confirm the permission).
- Changing the organization or branch filters takes effect on the next scrape — the cached branch list is invalidated on save.
