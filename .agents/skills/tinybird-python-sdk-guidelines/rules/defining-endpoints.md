# Defining Endpoints (Pipes)

## Basic Endpoint Definition

```python
from tinybird_sdk import define_endpoint, node, t, p

top_pages = define_endpoint(
    "top_pages",
    {
        "description": "Get the most visited pages",
        "params": {
            "start_date": p.date_time(),
            "end_date": p.date_time(),
            "limit": p.int32().optional(10),
        },
        "nodes": [
            node(
                {
                    "name": "aggregated",
                    "sql": """
                        SELECT pathname, count() AS views
                        FROM page_views
                        WHERE timestamp >= {{DateTime(start_date)}}
                          AND timestamp <= {{DateTime(end_date)}}
                        GROUP BY pathname
                        ORDER BY views DESC
                        LIMIT {{Int32(limit, 10)}}
                    """,
                }
            )
        ],
        "output": {
            "pathname": t.string(),
            "views": t.uint64(),
        },
    },
)
```

## Parameter Types

The `p` object provides parameter definitions:

- `p.string()` - String parameter
- `p.int32()`, `p.int64()` - Integer parameters
- `p.float32()`, `p.float64()` - Float parameters
- `p.date_time()` - DateTime parameter
- `p.date()` - Date parameter

## Parameter Modifiers

- `.optional(default_value)` - Make parameter optional with a default
- `.describe(text)` - Add description for documentation

Example:
```python
params = {
    "limit": p.int32().optional(10),
    "filter": p.string().optional(""),
    "status": p.string().optional("active").describe("Filter by status"),
}
```

## Internal Pipes (Non-API)

Use `define_pipe` for pipes not exposed as API endpoints:

```python
from tinybird_sdk import define_pipe, node, p

filtered_events = define_pipe(
    "filtered_events",
    {
        "description": "Filter events by date range",
        "params": {
            "start_date": p.date_time(),
            "end_date": p.date_time(),
        },
        "nodes": [
            node(
                {
                    "name": "filtered",
                    "sql": """
                        SELECT * FROM events
                        WHERE timestamp >= {{DateTime(start_date)}}
                          AND timestamp <= {{DateTime(end_date)}}
                    """,
                }
            )
        ],
    },
)
```

## Multi-Node Pipes

Define multiple nodes for complex transformations:

```python
nodes = [
    node(
        {
            "name": "filtered",
            "sql": """
                SELECT * FROM events
                WHERE timestamp >= {{DateTime(start_date)}}
            """,
        }
    ),
    node(
        {
            "name": "aggregated",
            "sql": """
                SELECT date, count() as total
                FROM filtered
                GROUP BY date
            """,
        }
    ),
]
```

## SQL Templating

Use Tinybird templating in SQL:

- `{{Type(param_name)}}` - Parameter with type
- `{{Type(param_name, default)}}` - Parameter with default value

```sql
WHERE user_id = {{String(user_id)}}
AND date >= {{Date(start_date, '2024-01-01')}}
LIMIT {{Int32(limit, 100)}}
```

## Schema Inference

```python
from tinybird_sdk.infer import infer_params_schema, infer_output_schema

params_schema = infer_params_schema(top_pages)
output_schema = infer_output_schema(top_pages)
```
