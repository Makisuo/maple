---
name: maple-dashboard-widgets
description: "Build, repair, or review Maple dashboard widgets via the MCP. Triggers on phrases like 'create_dashboard', 'add_dashboard_widget', 'update_dashboard_widget', 'dashboard widget JSON', 'QueryDraft', 'trace dashboard widget', 'Invalid input for getQueryBuilderTimeseries', or any session that submits raw widget JSON to the maple MCP. Covers the trace QueryDraft required-but-vestigial fields, the custom whereClause grammar, valid aggregations per data source, groupBy prefix conventions, the stat-widget `reduceToValue` transform, hiding auxiliary series on formula charts, and the verification step (MCP success ≠ query success)."
---

# Maple dashboard widgets via MCP

## When to use this skill

When you are constructing **raw widget JSON** for any of:

- `mcp__maple__create_dashboard` with a `dashboard_json` payload
- `mcp__maple__add_dashboard_widget`
- `mcp__maple__update_dashboard_widget`

If you are creating a fresh dashboard, **prefer the simplified `widgets` array on `create_dashboard`** (`SimpleWidgetSpec` at [apps/api/src/mcp/tools/create-dashboard.ts:94](apps/api/src/mcp/tools/create-dashboard.ts:94)). It side-steps every trap below — fill in `title`, `source`, `metric`, optional `group_by`, optional `service_name`, and the tool builds the full shape for you. Raw JSON is for cases the simplified spec can't express (multi-query charts, formulas, hidden series, non-default transforms).

## Trap 1 — Trace widgets need `metricName` and `metricType` (set `isMonotonic` too)

The Effect schema at [apps/web/src/api/tinybird/query-builder-timeseries.ts:28](apps/web/src/api/tinybird/query-builder-timeseries.ts:28) marks `metricName` and `metricType` as required fields, even when `dataSource: "traces"` makes them meaningless. Omitting either produces a decode error like `Missing key at ["queries"][0]["metricName"]`. `isMonotonic` is technically `optionalKey` in the schema, but the canonical factory `createQueryDraft` ([packages/query-engine/src/query-builder/model.ts:143](packages/query-engine/src/query-builder/model.ts:143)) always sets it — include it for parity.

For trace queries use these exact values:

```json
"metricName": "",
"metricType": "gauge",
"isMonotonic": false
```

Omitting them produces `Invalid input for getQueryBuilderTimeseries` in the browser even though the MCP call returned success.

## Trap 2 — `whereClause` is a custom grammar, not SQL

Parser: [packages/domain/src/where-clause.ts:7](packages/domain/src/where-clause.ts:7). Supported operators (the **only** supported operators):

| Operator | Example |
|---|---|
| `=` | `service.name = "ingest"` |
| `>` `<` `>=` `<=` | `http.request.body.size > 1000` |
| `contains` | `http.route contains "v1"` |
| `exists` | `maple.signal exists` |

Rules:

- Clauses join with ` AND ` (case-insensitive). No `OR`, no parentheses.
- Keys are normalized to lowercase by the parser.
- Quoted values use double quotes.
- **There is no `IS NULL` / `IS NOT NULL`.** To require an attribute be present, use `<key> exists`. This is the single most common mistake.

Wrong:

```
service.name = "ingest" AND maple.signal IS NOT NULL
```

Right:

```
service.name = "ingest" AND maple.signal exists
```

## Minimum-viable trace chart widget JSON

Use as a template. Fill `whereClause`, `groupBy`, `aggregation`, `display.title`, `display.unit`, `layout`:

```json
{
  "id": "w0",
  "visualization": "chart",
  "dataSource": {
    "endpoint": "custom_query_builder_timeseries",
    "params": {
      "queries": [
        {
          "id": "q-w0",
          "name": "A",
          "enabled": true,
          "hidden": false,
          "dataSource": "traces",
          "signalSource": "default",
          "metricName": "",
          "metricType": "gauge",
          "isMonotonic": false,
          "whereClause": "service.name = \"ingest\" AND maple.signal exists",
          "aggregation": "count",
          "stepInterval": "",
          "orderByDirection": "desc",
          "addOns": {
            "groupBy": true,
            "having": false,
            "orderBy": false,
            "limit": false,
            "legend": false
          },
          "groupBy": ["maple.signal"],
          "having": "",
          "orderBy": "",
          "limit": "",
          "legend": ""
        }
      ],
      "formulas": [],
      "comparison": { "mode": "none", "includePercentChange": true },
      "debug": false
    }
  },
  "display": {
    "title": "Requests by Signal",
    "chartId": "query-builder-bar",
    "chartPresentation": { "legend": "visible" },
    "stacked": true,
    "curveType": "linear",
    "unit": "number"
  },
  "layout": { "x": 0, "y": 0, "w": 6, "h": 4 }
}
```

## Stat widget delta

For `visualization: "stat"`, add `dataSource.transform.reduceToValue`. Transform schema is at [apps/web/src/components/dashboard-builder/types.ts:42](apps/web/src/components/dashboard-builder/types.ts:42):

```json
"transform": {
  "reduceToValue": { "field": "value", "aggregate": "sum" }
}
```

Valid `aggregate` values: `"sum" | "first" | "count" | "avg" | "max" | "min"`. **No `"last"`.** Without `reduceToValue`, the series array passes through to the renderer and the stat shows `[object Object],...`.

## Valid `aggregation` values per `dataSource`

From `normalizeTraceAggregation` / `normalizeMetricsAggregation` in [apps/web/src/components/dashboard-builder/ai/normalize-widget-proposal.ts:148](apps/web/src/components/dashboard-builder/ai/normalize-widget-proposal.ts:148):

- **traces:** `count`, `avg_duration`, `p50_duration`, `p95_duration`, `p99_duration`, `error_rate`
- **metrics:** `rate`, `increase`, `avg`, `sum`, `count`, `min`, `max`, `p50`, `p95`, `p99`
- **logs:** `count`

`rate` / `sum` / `increase` are **invalid for traces** — a common mistake when porting metrics widgets to traces.

## `groupBy` prefix conventions

Source-dependent:

- **traces:** unprefixed dotted attribute names — `maple.signal`, `error.type`, `http.response.status_code`, `service.name`, `maple.org_id`.
- **logs:** unprefixed — `service.name`, `severity`.
- **metrics:** `attr.` prefix on resource/attribute keys — `attr.signal`, `attr.status`, `attr.org_id`.

## `display.unit` is mandatory

Always set `display.unit` on chart and stat widgets. The default is `"number"`. Pick more specific where applicable:

- `duration_ms` for latency aggregations (`avg_duration`, `p50_duration`, `p95_duration`, `p99_duration`)
- `percent` for `error_rate`
- `number` for `count`
- `bytes` / `GB` for size aggregations

## Hiding auxiliary queries on charts with formulas

When a chart uses `formulas` and the auxiliary queries shouldn't render on their own, `query.hidden: true` is **not enough on its own** for the raw-JSON path — that flag is only consumed by the UI builder to generate the actual transform. For raw JSON, pair it with `dataSource.transform.hideSeries.baseNames`:

```json
"transform": {
  "hideSeries": { "baseNames": ["A", "B"] }
}
```

`baseNames` matches each hidden query's `legend || name`. Otherwise the auxiliary series render at full scale and skew percent-axis charts to absurd values (raw counts showing as "1200%").

## Verification — MCP success ≠ query success

`update_dashboard_widget` and friends return success even when the stored shape will fail at query time. After submitting:

1. Call `mcp__maple__inspect_chart_data` against the widget, **or**
2. Call `mcp__maple__get_dashboard` to read back the stored JSON and confirm shape, **or**
3. Load the dashboard URL in the browser and watch for `Invalid input for getQueryBuilderTimeseries`.

If you see that error, the culprit is almost always Trap 1 (missing trace required fields) or Trap 2 (SQL `IS NULL` instead of `exists`).

**Two failure modes, only one is visible to the schema.** The Effect schema validates structure (`metricName`/`metricType` presence) but `whereClause` is just `Schema.String` — the parser ([packages/domain/src/where-clause.ts](packages/domain/src/where-clause.ts)) accepts the field at decode time and silently drops unsupported clauses at query time. So if you fix Trap 1 and re-submit, the missing-key error disappears, but a Trap 2 `IS NOT NULL` will then degrade to "no `maple.signal` filter applied" without producing any error in the UI — just wrong/empty results. Always run `parseWhereClause` on the clause (or eyeball it against the operator table above) in the same pass as the schema fix.

## Quick checklist before submitting widget JSON

- [ ] Trace queries include `metricName: ""`, `metricType: "gauge"`, `isMonotonic: false`.
- [ ] `whereClause` uses only `=`, `>`, `<`, `>=`, `<=`, `contains`, `exists`, joined by ` AND `.
- [ ] `aggregation` is valid for the chosen `dataSource` (no `rate`/`sum` on traces).
- [ ] `groupBy` uses the right prefix (`attr.` for metrics; unprefixed for traces/logs).
- [ ] `display.unit` is set (and matches the aggregation — `duration_ms`, `percent`, etc.).
- [ ] Stat widgets include `dataSource.transform.reduceToValue`.
- [ ] Formula charts with hidden queries include `dataSource.transform.hideSeries.baseNames`.
- [ ] After submitting, verify with `inspect_chart_data` or by loading the dashboard.
