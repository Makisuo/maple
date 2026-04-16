# Tokens

## Static Tokens

Define named tokens and attach them to datasources and endpoints:

```python
from tinybird_sdk import define_datasource, define_endpoint, define_token, node, t

# Define tokens
app_token = define_token("app_read")
ingest_token = define_token("ingest_token")

# Attach to datasource
events = define_datasource(
    "events",
    {
        "schema": {
            "timestamp": t.date_time(),
            "event_name": t.string(),
        },
        "tokens": [
            {"token": app_token, "scope": "READ"},
            {"token": ingest_token, "scope": "APPEND"},
        ],
    },
)

# Attach to endpoint
top_events = define_endpoint(
    "top_events",
    {
        "nodes": [node({"name": "endpoint", "sql": "SELECT * FROM events LIMIT 10"})],
        "output": {"timestamp": t.date_time(), "event_name": t.string()},
        "tokens": [{"token": app_token, "scope": "READ"}],
    },
)
```

### Token Scopes

| Scope | Description |
|-------|-------------|
| `READ` | Read access |
| `APPEND` | Append/ingest access |

## JWT Token Creation

Create short-lived JWT tokens for secure scoped access:

```python
from datetime import datetime, timedelta, timezone
from tinybird_sdk import create_client

client = create_client(
    {
        "base_url": "https://api.tinybird.co",
        "token": "p.your_admin_token",
    }
)

result = client.tokens.create_jwt(
    {
        "name": "user_123_session",
        "expires_at": datetime.now(tz=timezone.utc) + timedelta(hours=1),
        "scopes": [
            {
                "type": "PIPES:READ",
                "resource": "user_dashboard",
                "fixed_params": {"user_id": 123},
            }
        ],
        "limits": {"rps": 10},
    }
)

jwt_token = result["token"]
```

### JWT Scope Types

| Scope | Description |
|-------|-------------|
| `PIPES:READ` | Read access to a specific pipe endpoint |
| `DATASOURCES:READ` | Read access to a datasource |
| `DATASOURCES:APPEND` | Append access to a datasource |

### JWT Scope Options

| Option | Description |
|--------|-------------|
| `resource` | Name of the pipe or datasource |
| `fixed_params` | Parameters embedded in token (cannot be overridden) |
| `filter` | SQL WHERE clause for datasource filtering |

### Example: Multi-Tenant Access

```python
# Create token for specific organization
org_token = client.tokens.create_jwt(
    {
        "name": "org_acme_access",
        "expires_at": datetime.now(tz=timezone.utc) + timedelta(days=1),
        "scopes": [
            {
                "type": "DATASOURCES:READ",
                "resource": "events",
                "filter": "org_id = 'acme'",
            },
            {
                "type": "PIPES:READ",
                "resource": "analytics_dashboard",
                "fixed_params": {"org_id": "acme"},
            },
        ],
        "limits": {"rps": 100},
    }
)
```

### JWT Limits

| Option | Description |
|--------|-------------|
| `rps` | Requests per second limit |
