# Creating the Tinybird Client

## Client Setup

```python
# lib/client.py
from tinybird_sdk import Tinybird
from .datasources import page_views
from .pipes import top_pages

tinybird = Tinybird(
    {
        "datasources": {"page_views": page_views},
        "pipes": {"top_pages": top_pages},
    }
)

__all__ = ["tinybird", "page_views", "top_pages"]
```

## Using the Client

### Data Ingestion

```python
from lib.client import tinybird

# Ingest one row
tinybird.page_views.ingest(
    {
        "timestamp": "2024-01-15 10:30:00",
        "pathname": "/home",
        "session_id": "abc123",
        "country": "US",
    }
)

# Batch ingestion (list of rows)
tinybird.page_views.ingest([
    {"timestamp": "2024-01-15 10:30:00", "pathname": "/home", "session_id": "abc", "country": "US"},
    {"timestamp": "2024-01-15 10:31:00", "pathname": "/about", "session_id": "abc", "country": "US"},
])
```

### Querying Endpoints

```python
from lib.client import tinybird

result = tinybird.top_pages.query(
    {
        "start_date": "2024-01-01 00:00:00",
        "end_date": "2024-01-31 23:59:59",
        "limit": 5,
    }
)

# Access result data
for row in result["data"]:
    print(f"{row['pathname']}: {row['views']} views")
```

## Datasource Operations

The client provides several operations for managing datasource data:

### Append from URL
```python
tinybird.page_views.append(
    {
        "url": "https://example.com/page_views.csv",
    }
)
```

### Replace (Full Snapshot)
```python
tinybird.page_views.replace(
    {
        "url": "https://example.com/page_views_full_snapshot.csv",
    }
)
```

### Delete Rows
```python
# Delete matching rows
tinybird.page_views.delete(
    {
        "delete_condition": "country = 'XX'",
    }
)

# Dry run to preview deletions
tinybird.page_views.delete(
    {
        "delete_condition": "country = 'XX'",
        "dry_run": True,
    }
)
```

### Truncate
```python
tinybird.page_views.truncate()
```

## Client Benefits

- **Convenience**: Access datasources and pipes as attributes
- **Consistency**: All operations use the same pattern
- **Organization**: Keep definitions and client in dedicated modules

## Python App Integration

For Python web apps (FastAPI, Django, Flask), import from a dedicated module:

```python
# In your FastAPI app
from lib.client import tinybird

@app.get("/analytics")
async def get_analytics():
    result = tinybird.top_pages.query({"start_date": "2024-01-01", "end_date": "2024-01-31"})
    return result["data"]
```
