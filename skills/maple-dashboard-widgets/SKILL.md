---
name: maple-dashboard-widgets
description: "Build, repair, or review Maple dashboard widgets via the MCP. Triggers on phrases like 'create_dashboard', 'add_dashboard_widget', 'update_dashboard_widget', 'dashboard widget JSON', 'QueryDraft', 'trace dashboard widget', 'Invalid input for getQueryBuilderTimeseries', or any session that submits raw widget JSON to the maple MCP. Covers the source-discriminated QueryDraft shape, the custom whereClause grammar, valid aggregations per data source, groupBy prefix conventions, the stat-widget `reduceToValue` transform, hiding auxiliary series on formula charts, and the verification step (MCP success ≠ query success)."
---

# Maple dashboard widgets via MCP

## When to use this skill

When you are constructing **raw widget JSON** for any of:

- `mcp__maple__create_dashboard` with a `dashboard_json` payload
- `mcp__maple__add_dashboard_widget`
- `mcp__maple__update_dashboard_widget`

If you are creating a fresh dashboard, **prefer the simplified `widgets` array on `create_dashboard`** (`SimpleWidgetSpec` at [apps/api/src/mcp/tools/create-dashboard.ts:94](apps/api/src/mcp/tools/create-dashboard.ts:94)). It side-steps every trap below — fill in `title`, `source`, `metric`, optional `group_by`, optional `service_name`, and the tool builds the full shape for you. Raw JSON is for cases the simplified spec can't express (multi-query charts, formulas, hidden series, non-default transforms).

## Trap 1 — Query drafts are source-discriminated

The query draft schema ([packages/domain/src/http/query-engine.ts](packages/domain/src/http/query-engine.ts)) is a union discriminated on `dataSource`. The metric-only fields — `metricName`, `metricType`, `isMonotonic`, `signalSource` — exist **only** on `dataSource: "metrics"` queries.

- For `dataSource: "traces"` or `"logs"`: **do not** include `metricName`, `metricType`, `isMonotonic`, or `signalSource`. They are not part of the trace/log query shape.
- For `dataSource: "metrics"`: include `metricName` (the metric to query), `metricType`, and optionally `isMonotonic` / `signalSource`.

A trace query that still carries empty `metricName`/`metricType` is legacy shape — stored dashboards were migrated to drop them.

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

## Gauge widget delta

`visualization: "gauge"` renders the same scalar as a stat, but on a 180° radial arc. It needs the **same `reduceToValue` transform** as a stat widget. Add gauge presentation under `display`:

```json
"display": {
  "unit": "percent",
  "gauge": { "min": 0, "max": 100 },
  "thresholds": [
    { "value": 70, "color": "var(--chart-3)" },
    { "value": 90, "color": "var(--destructive)" }
  ]
}
```

`display.thresholds` color the arc (the highest threshold ≤ the value wins) and place tick marks. `gauge.min`/`max` default to `0`/`100`. Arc color falls back to `var(--chart-1)` when no threshold matches.

## Threshold lines on time-series charts

`display.thresholds` also works on `chart` widgets — each entry draws a dashed horizontal `ReferenceLine` across line/area/bar charts, with an optional `label`. Reuse it to mark SLO/alert boundaries.

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

If you see that error, the culprit is almost always Trap 1 (metric fields on a trace/log query, or a malformed query draft) or Trap 2 (SQL `IS NULL` instead of `exists`).

**`whereClause` failures are invisible to the schema.** `whereClause` is just `Schema.String` — the parser ([packages/domain/src/where-clause.ts](packages/domain/src/where-clause.ts)) accepts the field at decode time and silently drops unsupported clauses at query time. A Trap 2 `IS NOT NULL` degrades to "no `maple.signal` filter applied" without producing any error in the UI — just wrong/empty results. Always run `parseWhereClause` on the clause (or eyeball it against the operator table above).

## Quick checklist before submitting widget JSON

- [ ] Trace/log queries omit `metricName`/`metricType`/`isMonotonic`/`signalSource`; metrics queries include `metricName` + `metricType`.
- [ ] `whereClause` uses only `=`, `>`, `<`, `>=`, `<=`, `contains`, `exists`, joined by ` AND `.
- [ ] `aggregation` is valid for the chosen `dataSource` (no `rate`/`sum` on traces).
- [ ] `groupBy` uses the right prefix (`attr.` for metrics; unprefixed for traces/logs).
- [ ] `display.unit` is set (and matches the aggregation — `duration_ms`, `percent`, etc.).
- [ ] Stat widgets include `dataSource.transform.reduceToValue`.
- [ ] Formula charts with hidden queries include `dataSource.transform.hideSeries.baseNames`.
- [ ] After submitting, verify with `inspect_chart_data` or by loading the dashboard.
