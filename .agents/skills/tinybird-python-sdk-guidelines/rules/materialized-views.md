# Materialized Views

Materialized views automatically aggregate data as it arrives, enabling real-time analytics.

## Basic Materialized View

A materialized view consists of:
1. A target datasource with aggregate columns
2. A materialized view definition that populates it

```python
from tinybird_sdk import define_datasource, define_materialized_view, engine, node, t

# Target datasource with aggregate columns
daily_stats = define_datasource(
    "daily_stats",
    {
        "schema": {
            "date": t.date(),
            "pathname": t.string(),
            "views": t.simple_aggregate_function("sum", t.uint64()),
            "unique_sessions": t.aggregate_function("uniq", t.string()),
        },
        "engine": engine.aggregating_merge_tree({"sorting_key": ["date", "pathname"]}),
    },
)

# Materialized view that populates it
daily_stats_mv = define_materialized_view(
    "daily_stats_mv",
    {
        "datasource": daily_stats,
        "nodes": [
            node(
                {
                    "name": "aggregate",
                    "sql": """
                        SELECT
                          toDate(timestamp) AS date,
                          pathname,
                          count() AS views,
                          uniqState(session_id) AS unique_sessions
                        FROM page_views
                        GROUP BY date, pathname
                    """,
                }
            )
        ],
    },
)
```

## Aggregate Types

### SimpleAggregateFunction

For simple aggregations (sum, min, max, any):

```python
"views": t.simple_aggregate_function("sum", t.uint64())
"min_value": t.simple_aggregate_function("min", t.float64())
"max_value": t.simple_aggregate_function("max", t.float64())
```

### AggregateFunction

For complex aggregations (uniq, quantile, etc.):

```python
"unique_users": t.aggregate_function("uniq", t.string())
"p95_latency": t.aggregate_function("quantile(0.95)", t.float64())
```

## SQL State Functions

In materialized view SQL, use state functions to prepare aggregates:

| Final Function | State Function |
|----------------|----------------|
| `count()` | `count()` (no state needed for SimpleAggregateFunction) |
| `sum(col)` | `sum(col)` (no state needed) |
| `uniq(col)` | `uniqState(col)` |
| `quantile(0.95)(col)` | `quantileState(0.95)(col)` |
| `avg(col)` | `avgState(col)` |

## Querying Materialized Views

When querying, use merge functions for AggregateFunction columns:

```python
endpoint = define_endpoint(
    "daily_stats_query",
    {
        "nodes": [
            node(
                {
                    "name": "query",
                    "sql": """
                        SELECT
                          date,
                          pathname,
                          sum(views) AS total_views,
                          uniqMerge(unique_sessions) AS unique_sessions
                        FROM daily_stats
                        GROUP BY date, pathname
                    """,
                }
            )
        ],
        "output": {
            "date": t.date(),
            "pathname": t.string(),
            "total_views": t.uint64(),
            "unique_sessions": t.uint64(),
        },
    },
)
```

## Engine Selection

Always use `aggregating_merge_tree` for materialized view targets:

```python
engine.aggregating_merge_tree(
    {
        "sorting_key": ["date", "dimension1", "dimension2"],
    }
)
```
