# Copy Pipes and Sink Pipes

## Copy Pipes

Copy pipes execute SQL and write results to a datasource on a schedule or on-demand.

### Scheduled Copy Pipe

```python
from tinybird_sdk import define_copy_pipe, node

daily_snapshot = define_copy_pipe(
    "daily_snapshot",
    {
        "datasource": events,  # Target datasource
        "copy_schedule": "0 0 * * *",  # Cron: daily at midnight
        "copy_mode": "append",
        "nodes": [
            node(
                {
                    "name": "snapshot",
                    "sql": """
                        SELECT today() AS snapshot_date, event_name, count() AS events
                        FROM events
                        WHERE toDate(timestamp) = today() - 1
                        GROUP BY event_name
                    """,
                }
            )
        ],
    },
)
```

### On-Demand Copy Pipe

```python
manual_report = define_copy_pipe(
    "manual_report",
    {
        "datasource": events,
        "copy_schedule": "@on-demand",
        "copy_mode": "replace",
        "nodes": [
            node(
                {
                    "name": "report",
                    "sql": "SELECT * FROM events WHERE timestamp >= now() - interval 7 day",
                }
            )
        ],
    },
)
```

### Copy Modes

| Mode | Description |
|------|-------------|
| `append` | Add rows to existing data (default) |
| `replace` | Replace all data in target datasource |

### Schedule Options

| Schedule | Description |
|----------|-------------|
| `"0 0 * * *"` | Cron expression (daily at midnight) |
| `"*/5 * * * *"` | Every 5 minutes |
| `"@on-demand"` | Manual trigger only |
| `"@once"` | Run once on deployment |

## Sink Pipes

Sink pipes publish query results to external systems (Kafka, S3).

### Kafka Sink

```python
from tinybird_sdk import define_sink_pipe, node

kafka_events_sink = define_sink_pipe(
    "kafka_events_sink",
    {
        "sink": {
            "connection": events_kafka,  # Kafka connection
            "topic": "events_export",
            "schedule": "@on-demand",
        },
        "nodes": [
            node(
                {
                    "name": "publish",
                    "sql": "SELECT timestamp, payload FROM kafka_events",
                }
            )
        ],
    },
)
```

### S3 Sink

```python
s3_events_sink = define_sink_pipe(
    "s3_events_sink",
    {
        "sink": {
            "connection": landing_s3,  # S3 connection
            "bucket_uri": "s3://my-bucket/exports/",
            "file_template": "events_{date}",
            "format": "csv",
            "schedule": "@once",
            "strategy": "create_new",
            "compression": "gzip",
        },
        "nodes": [
            node(
                {
                    "name": "export",
                    "sql": "SELECT timestamp, session_id FROM s3_landing",
                }
            )
        ],
    },
)
```

### S3 Sink Options

| Option | Description |
|--------|-------------|
| `bucket_uri` | S3 bucket and path prefix |
| `file_template` | Filename template (supports `{date}`, `{time}`) |
| `format` | Output format: `csv`, `json`, `parquet` |
| `schedule` | Cron expression or `@on-demand`, `@once` |
| `strategy` | `create_new` or `overwrite` |
| `compression` | `none`, `gzip`, `lz4` |
