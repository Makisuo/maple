---
title: "Python"
description: "Send traces, logs, and metrics from a Python app to Maple Local with opentelemetry-instrument."
group: "Sending Data"
order: 3
---

The quickest path is the `opentelemetry-instrument` wrapper — it auto-instruments Flask, FastAPI, Django, requests, SQLAlchemy, and more without code changes.

## Install

```bash
pip install opentelemetry-distro opentelemetry-exporter-otlp-proto-http
opentelemetry-bootstrap -a install   # detect + install instrumentations for your deps
```

## Zero-code setup

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4318"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_SERVICE_NAME="my-python-service"
opentelemetry-instrument python app.py
```

> The Python distro defaults to OTLP/**gRPC**, which Maple Local doesn't speak — the `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` line is required.

## Explicit setup

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.resources import Resource
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

provider = TracerProvider(resource=Resource.create({"service.name": "my-python-service"}))
provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(endpoint="http://127.0.0.1:4318/v1/traces"))
)
trace.set_tracer_provider(provider)

tracer = trace.get_tracer(__name__)
with tracer.start_as_current_span("do-work"):
    ...
```

Note that the Python HTTP exporter takes the **full signal path** (`/v1/traces`), not just the base URL.

## Verify

```bash
maple services
maple traces --service my-python-service --since 5m
```
