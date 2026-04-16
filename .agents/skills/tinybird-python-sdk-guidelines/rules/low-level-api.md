# Public Tinybird API (Low-Level)

For cases requiring a decoupled API wrapper without the high-level client:

## Creating the API Client

```python
from tinybird_sdk import create_tinybird_api

api = create_tinybird_api(
    {
        "base_url": "https://api.tinybird.co",
        "token": "p.your_token",
    }
)
```

## Querying Endpoints

```python
top_pages = api.query(
    "top_pages",
    {
        "start_date": "2024-01-01",
        "end_date": "2024-01-31",
        "limit": 5,
    },
)

# top_pages["data"] contains the result rows
```

## Ingesting Data

```python
# Ingest one row
api.ingest(
    "events",
    {
        "timestamp": "2024-01-15 10:30:00",
        "event_name": "page_view",
        "pathname": "/home",
    },
)

# Batch ingestion
api.ingest(
    "events",
    [
        {"timestamp": "2024-01-15 10:30:00", "event_name": "page_view", "pathname": "/home"},
        {"timestamp": "2024-01-15 10:31:00", "event_name": "click", "pathname": "/home"},
    ],
)
```

## Retry Behavior

Retries are disabled by default. Enable with `max_retries`:

```python
api.ingest(
    "events",
    {"timestamp": "2024-01-15 10:31:00", "event_name": "button_click", "pathname": "/pricing"},
    {"max_retries": 3},
)
```

- 429 retries use `Retry-After` / `X-RateLimit-Reset` headers
- 503 retries use SDK default exponential backoff

## Datasource Operations

### Append from URL
```python
api.append_datasource(
    "events",
    {"url": "https://example.com/events.csv"},
)
```

### Delete Rows
```python
api.delete_datasource(
    "events",
    {"delete_condition": "event_name = 'test'"},
)

# Dry run
api.delete_datasource(
    "events",
    {"delete_condition": "event_name = 'test'", "dry_run": True},
)
```

### Truncate
```python
api.truncate_datasource("events")
```

## Executing Raw SQL

```python
sql_result = api.sql("SELECT count() AS total FROM events")
# sql_result["data"][0]["total"]
```

## Per-Request Token Override

```python
workspace_response = api.request_json(
    "/v1/workspace",
    token="p.branch_or_jwt_token",
)
```

## When to Use Low-Level API

- Existing projects not using Python definitions
- Dynamic endpoint names or parameters
- Direct SQL execution needs
- Gradual migration from other HTTP clients
- Multi-tenant scenarios with different tokens
