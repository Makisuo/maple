# Defining Connections

Connections define external data sources that Tinybird can integrate with.

## Kafka Connection

```python
from tinybird_sdk import define_kafka_connection, secret

events_kafka = define_kafka_connection(
    "events_kafka",
    {
        "bootstrap_servers": "kafka.example.com:9092",
        "security_protocol": "SASL_SSL",
        "sasl_mechanism": "PLAIN",
        "key": secret("KAFKA_KEY"),
        "secret": secret("KAFKA_SECRET"),
    },
)
```

## S3 Connection

```python
from tinybird_sdk import define_s3_connection

landing_s3 = define_s3_connection(
    "landing_s3",
    {
        "region": "us-east-1",
        "arn": "arn:aws:iam::123456789012:role/tinybird-s3-access",
    },
)
```

## GCS Connection

```python
from tinybird_sdk import define_gcs_connection, secret

landing_gcs = define_gcs_connection(
    "landing_gcs",
    {
        "service_account_credentials_json": secret("GCS_SERVICE_ACCOUNT_CREDENTIALS_JSON"),
    },
)
```

## Using Secrets

The `secret()` function references secrets stored in Tinybird:

```python
from tinybird_sdk import secret

# Reference a secret by name
api_key = secret("MY_API_KEY")
```

Secrets must be created in Tinybird before deploying connections that use them.

## Connection Configuration Options

### Kafka Options

| Option | Description |
|--------|-------------|
| `bootstrap_servers` | Kafka broker addresses |
| `security_protocol` | Protocol (e.g., `SASL_SSL`, `PLAINTEXT`) |
| `sasl_mechanism` | SASL mechanism (e.g., `PLAIN`, `SCRAM-SHA-256`) |
| `key` | SASL username (use `secret()`) |
| `secret` | SASL password (use `secret()`) |

### S3 Options

| Option | Description |
|--------|-------------|
| `region` | AWS region |
| `arn` | IAM role ARN for cross-account access |

### GCS Options

| Option | Description |
|--------|-------------|
| `service_account_credentials_json` | Service account JSON (use `secret()`) |

## Using Connections in Sink Pipes

Connections are referenced when defining sink pipes:

```python
from tinybird_sdk import define_sink_pipe, node

kafka_sink = define_sink_pipe(
    "kafka_events_sink",
    {
        "sink": {
            "connection": events_kafka,  # Reference the connection
            "topic": "events_export",
            "schedule": "@on-demand",
        },
        "nodes": [
            node({"name": "publish", "sql": "SELECT * FROM events"})
        ],
    },
)
```
