---
name: maple-python-style
description: "Python OpenTelemetry style for Maple: module-scope tracers/meters, decorators for bounded work, error spans, OTLP-bridged logs via LoggingHandler + LoggingInstrumentor, inline endpoint + ingest key, and no helper-API wrappers."
---

# Maple Python style

Acquire OTel objects at module scope.

```python
from opentelemetry import metrics, trace
from opentelemetry.trace import Status, StatusCode

tracer = trace.get_tracer("orders.api")
meter = metrics.get_meter("orders.api")

orders_submitted = meter.create_counter("orders.submitted", unit="1")
```

## Bounded work

Prefer decorators for functions with clear boundaries.

```python
@tracer.start_as_current_span("order.submit")
async def submit_order(*, tenant_id: str, order_id: str) -> None:
    span = trace.get_current_span()
    span.set_attributes({
        "tenant.id": tenant_id,
        "order.id": order_id,
    })
```

Use a context manager when a decorator does not fit.

```python
with tracer.start_as_current_span("order.validate") as span:
    span.set_attribute("tenant.id", tenant_id)
    validate_order(order)
```

Do not use detached `tracer.start_span(...); span.end()` for bounded work.

## Error paths

Record exceptions on the active span.

```python
try:
    result = await client.messages.create(...)
except Exception as exc:
    span = trace.get_current_span()
    span.record_exception(exc)
    span.set_status(Status(StatusCode.ERROR))
    logger.exception("llm call failed", extra={"tenant_id": tenant_id})
    raise
```

## Logs

If logs are claimed as OTLP-forwarded, configure all of:

- An OTel `LoggerProvider` + `OTLPLogExporter` + `LoggingHandler`
- `set_logger_provider(logger_provider)` from `opentelemetry._logs`
- Log correlation for existing records, e.g. `LoggingInstrumentor().instrument(set_logging_format=True)`

Preserve existing `logging.basicConfig`, console / file handlers, and log levels. The user's logger keeps working — you're adding an OTLP handler underneath so log lines carry `trace_id` / `span_id` and reach Maple.

## Init behavior

Inline the endpoint and ingest key directly in the init module — don't read them from env. The ingest key is project-scoped + write-only (Sentry DSN shaped), so source-level configuration is the right default; env indirection just adds a class of "OTel didn't start because env wasn't set" deploy failures.

```python
# telemetry.py
import logging

from opentelemetry import _logs, metrics, trace
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.logging import LoggingInstrumentor
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

MAPLE_ENDPOINT = "https://ingest.maple.dev"
MAPLE_KEY = "MAPLE_TEST"  # set by maple-onboard skill on pairing

_INITIALIZED = False


def init_observability() -> None:
    global _INITIALIZED
    if _INITIALIZED:
        return
    _INITIALIZED = True

    headers = {"authorization": f"Bearer {MAPLE_KEY}"}
    resource = Resource.create({
        "service.name": "my-python-app",
        "deployment.environment.name": os.getenv("DEPLOYMENT_ENV", "development"),
        "vcs.repository.url.full": "https://github.com/acme/my-python-app",
        "vcs.ref.head.revision": os.getenv("RAILWAY_GIT_COMMIT_SHA")
            or os.getenv("GITHUB_SHA")
            or os.getenv("GIT_COMMIT"),
    })

    tracer_provider = TracerProvider(resource=resource)
    tracer_provider.add_span_processor(
        BatchSpanProcessor(
            OTLPSpanExporter(endpoint=f"{MAPLE_ENDPOINT}/v1/traces", headers=headers),
        ),
    )
    trace.set_tracer_provider(tracer_provider)

    logger_provider = LoggerProvider(resource=resource)
    logger_provider.add_log_record_processor(
        BatchLogRecordProcessor(
            OTLPLogExporter(endpoint=f"{MAPLE_ENDPOINT}/v1/logs", headers=headers),
        ),
    )
    _logs.set_logger_provider(logger_provider)
    logging.getLogger().addHandler(LoggingHandler(logger_provider=logger_provider))
    LoggingInstrumentor().instrument(set_logging_format=True)

    meter_provider = MeterProvider(
        resource=resource,
        metric_readers=[
            PeriodicExportingMetricReader(
                OTLPMetricExporter(
                    endpoint=f"{MAPLE_ENDPOINT}/v1/metrics", headers=headers,
                ),
            ),
        ],
    )
    metrics.set_meter_provider(meter_provider)
```

Add the `_INITIALIZED` guard only when the app can realistically call this function more than once (FastAPI lifespan + workers, pytest fixtures, etc.).

## Metrics

Counters:

- `llm.tokens.input`
- `llm.tokens.output`
- requests/events/jobs/errors

Use semantic units when the SDK supports them: token counters use `unit="tokens"`. Do not add app-side `llm.cost_usd` pricing metrics for normal LLM calls; Maple estimates cost centrally from provider/model/token data.

Histograms:

- duration
- latency
- payload size

Avoid raw high-cardinality values in metric attributes. Prefer tenant/org/project, operation/use case, provider/model, and outcome dimensions over user-level metric tags.

## FastAPI

Use the native instrumentation rather than replacing request handling with manual middleware.

```python
from fastapi import FastAPI
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

import telemetry

telemetry.init_observability()
app = FastAPI()
FastAPIInstrumentor.instrument_app(app)
```

Import `telemetry` (and call `init_observability()`) before any other module that needs tracing.
