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

Never add `metricName`/`metricType`/`isMonotonic`/`signalSource` to a trace or log query — they belong solely to `dataSource: "metrics"` queries. (Older stored dashboards were migrated to drop them; new widgets must not reintroduce them.)

## Trap 2 — `whereClause` is a custom grammar, not SQL

Parser: [packages/domain/src/where-clause.ts:7](packages/domain/src/where-clause.ts:7). Supported operators (the **only** supported operators):

| Operator | Example |
|---|---|
| `=` `!=` | `service.name = "ingest"`, `error.type != "Timeout"` |
| `>` `<` `>=` `<=` | `http.request.body.size > 1000` |
| `contains` `!contains` | `http.route contains "v1"`, `http.route !contains "/health"` |
| `exists` `!exists` | `maple.signal exists`, `db.system !exists` |

Rules:

- Clauses join with ` AND ` (case-insensitive). No `OR`, no parentheses.
- Keys are normalized to lowercase by the parser.
- Quoted values use double quotes.
- **There is no `IS NULL` / `IS NOT NULL`.** To require an attribute be present, use `<key> exists`; to require it absent, `<key> !exists`. This is the single most common mistake.
- **Attribute filters work directly.** On `dataSource: "traces"` you can filter by any span/resource attribute — `query.context = "tracesList"`, `error.type != "Timeout"`, `db.system = "clickhouse"`. Bare keys outside the small structured allowlist (`service.name`, `span.name`, `deployment.environment`, `deployment.commit_sha`, `root_only`, `has_error`) are auto-treated as span attributes; you can also write them explicitly as `attr.<key>` / `resource.<key>`. Cap: 5 `attr.*` + 5 `resource.*` filters per query.
- **Unhonored clauses are now rejected at write time.** `add_dashboard_widget` / `update_dashboard_widget` / `replace_dashboard_widgets` run the builder before persisting and FAIL (nothing saved) if a clause can't be honored — e.g. exceeding the attr cap, or an unsupported logs/metrics filter key. (This used to be a silent drop.)

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

## Per-widget time range (`timeRange`)

Widgets follow the dashboard's time range unless they carry their own `timeRange` — an optional
top-level field on the widget, beside `display` and `layout`, in the same shape as the dashboard's:

```json
{
  "id": "w0",
  "visualization": "stat",
  "timeRange": { "type": "relative", "value": "30m" },
  "dataSource": { ... },
  "display": { "title": "Active trains", "unit": "number" },
  "layout": { "x": 0, "y": 0, "w": 3, "h": 3 }
}
```

Absolute form: `{ "type": "absolute", "startTime": "2026-08-01T00:00:00Z", "endTime": "2026-08-02T00:00:00Z" }`.
Relative `value` is the usual shorthand (`30m`, `6h`, `7d`, `2w`, `3mo`).

- **Omit it for almost every widget.** The whole point of a dashboard time picker is that the
  board moves as one; a pinned tile is for cases where the window is part of what the tile
  *means* — "active in the last 30 minutes" on a board scoped to the last 7 days, or a 24h
  trend sitting beside a 7d comparison.
- A relative override rebases against "now" on every dashboard refresh, exactly like the board's
  own relative range. An absolute override never moves.
- The widget header renders a small clock label with the pinned range, so a reader can see the
  tile isn't on the board's range.
- Dashboard **variables** still apply normally — the override replaces the time window only.
- `update_dashboard_widget` replaces the whole widget: **leaving `timeRange` out of the JSON
  removes an existing override.** Re-send it to keep it.
- `add_dashboard_widget` takes it as the separate `time_range_json` parameter (the widget-JSON
  tools take it inline).
- `inspect_chart_data` and the auto-validation summary evaluate a pinned widget on *its* window
  and report `source: "widget"` in the time range they used.

## Threshold lines on time-series charts

`display.thresholds` also works on `chart` widgets — each entry draws a dashed horizontal `ReferenceLine` across line/area/bar charts, with an optional `label`. Reuse it to mark SLO/alert boundaries.

## Valid `aggregation` values per `dataSource`

From `normalizeTraceAggregation` / `normalizeMetricsAggregation` in [apps/web/src/components/dashboard-builder/ai/normalize-widget-proposal.ts:148](apps/web/src/components/dashboard-builder/ai/normalize-widget-proposal.ts:148):

- **traces:** `count`, `avg_duration`, `p50_duration`, `p95_duration`, `p99_duration`, `error_rate`
- **metrics:** `rate`, `increase`, `avg`, `sum`, `count`, `min`, `max`, `p50`, `p95`, `p99`
- **logs:** `count`

`rate` / `sum` / `increase` are **invalid for traces** — a common mistake when porting metrics widgets to traces.

## `groupBy` prefix conventions

The query-builder `groupBy` accepts a small **literal allowlist per source**; everything else
MUST be prefixed `attr.<key>`. A token that isn't recognized and isn't `attr.`-prefixed is
dropped — and now causes the widget mutation tools to **reject the write** rather than silently
breaking the breakdown.

- **traces:** bare literals are only `service` / `service.name`, `span` / `span.name`, `status` / `status.code`, `http.method`, `none` / `all`. **Every other attribute needs the `attr.` prefix** — `attr.maple.signal`, `attr.error.type`, `attr.http.response.status_code`, `attr.maple.org_id`, etc. (Writing `error.type` bare in `groupBy` does NOT work — use `attr.error.type`.)
- **logs:** bare literals only — `service` / `service.name`, `severity`, `none`. Logs do not support `attr.*` group by.
- **metrics:** bare `service` / `none`; everything else uses `attr.` — `attr.signal`, `attr.status`, `attr.org_id`.

If a `groupBy` on an attribute finds zero distinct values, the chart collapses to a single
`all` series. `inspect_chart_data` now flags this as `EMPTY_GROUPING` (verdict `broken`) instead
of silently showing the ungrouped total.

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

The widget mutation tools now do two things automatically that used to be silent gaps:

- **Pre-persist rejection:** unhonored where-clause/groupBy clauses fail the write (nothing saved) — so a `IS NULL`, a 6th attr filter, or an unsupported logs/metrics key surfaces as an error instead of degrading to wrong/empty data.
- **Auto-validation:** the response includes an `inspect_chart_data` summary (verdict + flags). `inspect_chart_data` now also **evaluates `formulas[]`** (so formula/hit-rate widgets verify end-to-end) and **applies `reduceToValue`** with the same first-numeric-field fallback the renderer uses (so stat-tile `reducedValue` reflects what renders). `SUSPICIOUS_GAP` is informational only — sparse/bursty data no longer downgrades the verdict.

Still confirm after submitting:

1. Read the returned validation summary; if `verdict` is `suspicious`/`broken`, fix and resubmit.
2. Call `mcp__maple__inspect_chart_data` for a deeper look, **or** `mcp__maple__get_dashboard` to read back the stored JSON, **or** load the dashboard URL.

Verdict flags worth knowing: `EMPTY_GROUPING` (groupBy found zero distinct values → one `all` series), `METRIC_NOT_FOUND` (a metrics widget references a metric name not in the warehouse — distinct from a real metric with no recent data), `BUILDER_WARNINGS` (a clause the engine couldn't honor).

If you see `Invalid input for getQueryBuilderTimeseries`, the culprit is almost always Trap 1 (metric fields on a trace/log query) or a malformed query draft.

## Rebuilding many widgets at once

To replace a dashboard's whole widget list in one validated, atomic write, use
`mcp__maple__replace_dashboard_widgets` (`widgets_json` = a JSON array of widget objects, same
shape as `widgets[]` from `get_dashboard`). `id` and `layout` are optional per widget
(auto-generated / auto-placed). Every widget is validated before anything persists — if one
widget's query can't be honored, nothing is saved. This is the safe middle ground between N
incremental `add_dashboard_widget` calls and the corruption-prone full `dashboard_json` replace.

## Quick checklist before submitting widget JSON

- [ ] Trace/log queries omit `metricName`/`metricType`/`isMonotonic`/`signalSource`; metrics queries include `metricName` + `metricType`.
- [ ] `whereClause` uses only `=`, `!=`, `>`, `<`, `>=`, `<=`, `contains`, `!contains`, `exists`, `!exists`, joined by ` AND ` (no SQL `IS NULL`).
- [ ] `aggregation` is valid for the chosen `dataSource` (no `rate`/`sum` on traces).
- [ ] `groupBy` uses the right prefix: bare only for the per-source allowlist (traces: `service`/`span`/`status`/`http.method`); **every other attribute needs `attr.<key>`** (traces & metrics). Logs: bare `service`/`severity` only.
- [ ] `display.unit` is set (and matches the aggregation — `duration_ms`, `percent`, etc.).
- [ ] Stat widgets include `dataSource.transform.reduceToValue`.
- [ ] Formula charts with hidden queries include `dataSource.transform.hideSeries.baseNames`.
- [ ] No `timeRange` on the widget unless the tile genuinely means a different window than the
      board — and if you're updating a pinned widget, the `timeRange` is still in the JSON.
- [ ] After submitting, read the auto-validation summary; verify `suspicious`/`broken` widgets with `inspect_chart_data` or by loading the dashboard.
