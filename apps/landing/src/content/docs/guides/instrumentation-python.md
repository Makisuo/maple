---
title: "Python Instrumentation"
description: "Instrument a Python application with OpenTelemetry and send traces, logs, and metrics to Maple."
group: "Instrumentation"
order: 5
sdk: "python"
---

This guide covers instrumenting a Python application to send traces and logs to Maple using the OpenTelemetry SDK.

> **Run this with Claude Code:** `maple-onboard` walks every service in the repo, installs OpenTelemetry, and verifies the bootstrap end-to-end. See the [maple-onboard skill](https://github.com/Makisuo/maple/tree/main/skills/maple-onboard).

## Prerequisites

- Python 3.8+
- A Maple project with an API key (or use the `MAPLE_TEST` placeholder while pairing -- see below)

## Install Dependencies

```bash
pip install opentelemetry-sdk \
  opentelemetry-exporter-otlp-proto-http \
  opentelemetry-instrumentation
```

## Configure the SDK

Create a `tracing.py` module to initialize the SDK. **Inline the endpoint and ingest key** -- the key is project-scoped and write-only (Sentry-DSN-shaped), so source-level configuration removes a class of "OTel didn't start because env vars weren't set" deploy failures.

```python
# tracing.py
import os
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource

MAPLE_ENDPOINT = "https://ingest.maple.dev"
MAPLE_KEY = "MAPLE_TEST"  # replace with your real key from Settings → API Keys

resource = Resource.create({
    "service.name": "my-python-app",
    "deployment.environment.name": os.getenv("DEPLOYMENT_ENV", "development"),
    "vcs.repository.url.full": "https://github.com/acme/my-python-app",
    "vcs.ref.head.revision": os.getenv("RAILWAY_GIT_COMMIT_SHA")
        or os.getenv("GITHUB_SHA")
        or os.getenv("GIT_COMMIT", ""),
})

provider = TracerProvider(resource=resource)
exporter = OTLPSpanExporter(
    endpoint=f"{MAPLE_ENDPOINT}/v1/traces",
    headers={"authorization": f"Bearer {MAPLE_KEY}"},
)
provider.add_span_processor(BatchSpanProcessor(exporter))
trace.set_tracer_provider(provider)
```

> **`MAPLE_TEST` placeholder:** While you're pairing your editor with Maple, the literal string `MAPLE_TEST` is accepted by the ingest gateway and discarded -- so the bootstrap can run end-to-end before you've created your first key. Once you have a real key, search-replace `MAPLE_TEST` in the file above with it.

Import this module early in your application startup, before other modules that need tracing:

```python
import tracing  # Initialize OpenTelemetry first
from myapp import create_app

app = create_app()
```

## Auto-Instrumentation

The easiest way to instrument common libraries is with the auto-instrumentation CLI.

First, install instrumentations for your installed packages:

```bash
opentelemetry-bootstrap -a install
```

Then run your application with the `opentelemetry-instrument` wrapper:

```bash
opentelemetry-instrument python app.py
```

This automatically instruments libraries like Flask, Django, requests, SQLAlchemy, psycopg2, redis, and many more.

Alternatively, install specific instrumentation packages for finer control:

```bash
pip install opentelemetry-instrumentation-flask \
  opentelemetry-instrumentation-requests \
  opentelemetry-instrumentation-sqlalchemy
```

```python
from opentelemetry.instrumentation.flask import FlaskInstrumentor
from opentelemetry.instrumentation.requests import RequestsInstrumentor

FlaskInstrumentor().instrument()
RequestsInstrumentor().instrument()
```

## FastAPI

FastAPI has a dedicated instrumentation package that traces every route as a span:

```bash
pip install opentelemetry-instrumentation-fastapi
```

```python
import tracing  # Initialize OpenTelemetry first
from fastapi import FastAPI
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

app = FastAPI()
FastAPIInstrumentor.instrument_app(app)
```

If you also use `httpx` or `requests` for outgoing calls, install the matching instrumentation packages -- they propagate trace context automatically so downstream services connect to the parent trace.

## Django

```bash
pip install opentelemetry-instrumentation-django
```

```python
# settings.py or top of wsgi.py
import tracing  # Initialize OpenTelemetry first
from opentelemetry.instrumentation.django import DjangoInstrumentor

DjangoInstrumentor().instrument()
```

The Django instrumentation creates a span per HTTP request and integrates with the ORM through `opentelemetry-instrumentation-dbapi`-backed packages (`opentelemetry-instrumentation-psycopg2`, `opentelemetry-instrumentation-sqlite3`, etc.).

## Custom Spans

Create custom spans to trace specific operations:

```python
from opentelemetry import trace
from opentelemetry.trace import StatusCode

tracer = trace.get_tracer("my-app")

def process_order(order_id: str):
    with tracer.start_as_current_span("process-order") as span:
        span.set_attribute("order.id", order_id)
        # Set peer.service when calling another service
        span.set_attribute("peer.service", "payment-api")

        try:
            result = charge_payment(order_id)
            return result
        except Exception as e:
            span.record_exception(e)
            span.set_status(StatusCode.ERROR, str(e))
            raise
```

Setting `peer.service` on outgoing calls makes them visible on Maple's [service map](/docs/concepts/otel-conventions#service-map).

## Log Correlation

Send logs to Maple with trace correlation by adding the OTel log exporter:

```bash
pip install opentelemetry-exporter-otlp-proto-http
```

```python
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry._logs import set_logger_provider

logger_provider = LoggerProvider(resource=resource)
logger_provider.add_log_record_processor(
    BatchLogRecordProcessor(
        OTLPLogExporter(
            endpoint="https://ingest.maple.dev/v1/logs",
            headers={"Authorization": "Bearer YOUR_API_KEY"},
        )
    )
)
set_logger_provider(logger_provider)
```

To bridge Python's standard `logging` module to OTel:

```python
import logging
from opentelemetry.sdk._logs import LoggingHandler

handler = LoggingHandler(logger_provider=logger_provider)
logging.getLogger().addHandler(handler)

# Now standard logging calls include trace context
logging.info("Order processed successfully")
```

## Environment Variables

As an alternative to programmatic configuration, set standard OTel environment variables:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_API_KEY"
export OTEL_SERVICE_NAME="my-python-app"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production,vcs.repository.url.full=https://github.com/acme/my-python-app"
```

Then use `opentelemetry-instrument` to run your app with auto-instrumentation and these settings applied automatically.

## Verify

1. Start your application
2. Generate some traffic (send a request, trigger an operation)
3. Open the Maple dashboard and check that traces appear in the traces view

If traces aren't appearing, verify:

- The ingest endpoint URL is correct
- Your API key is valid
- Your application can reach `ingest.maple.dev` (or your self-hosted URL)
