# Database query observability

Maple gives every database call first-class treatment using the standard
[OpenTelemetry database semantic conventions](https://opentelemetry.io/docs/specs/semconv/db/database-spans/).
If your services are instrumented with an OTel-aware database client — which most
SDKs enable automatically — you get, with **no extra configuration**:

- **Query timing inline in every trace.** A database call's client span shows up
  in the waterfall like any other span, and its detail panel renders a database
  summary block (system, namespace, table, operation, rows returned, server)
  derived from the `db.*` attributes.
- **A cross-service Queries surface.** Every distinct query *shape* (the query
  with literals normalized to `?`) is aggregated across services with call
  volume, error rate, and p50/p95/p99 latency, so you can find your slowest and
  busiest queries and drill straight to sample traces.

This works for **any** database — PostgreSQL, MySQL, ClickHouse, Redis, MongoDB,
and more — because it reads only the vendor-neutral semantic conventions.

## Attributes Maple reads

| Attribute | Used for |
| --- | --- |
| `db.system.name` (legacy `db.system`) | Identifies the database; drives the summary block and per-system grouping. |
| `db.query.text` (legacy `db.statement`) | The query; normalized into a low-cardinality **shape** for grouping. |
| `db.query.summary` | Preferred human label for a query shape (e.g. `SELECT users`). |
| `db.operation.name`, `db.collection.name`, `db.namespace` | Compose a label when `db.query.summary` is absent. |
| `db.query.fingerprint` (legacy `db.statement.fingerprint`) | Explicit grouping key when the instrumentation provides one. |
| `db.response.returned_rows` | Rows returned, shown in the span summary. |
| `db.operation.batch.size` | Batch size (only present for batches). |
| `server.address` / `server.port` | The database endpoint. |
| `error.type`, `db.response.status_code` | Failure outcome. |

Query text is grouped by *shape*: literals are stripped to `?` and `IN (...)`
lists are collapsed, so `WHERE id = 1` and `WHERE id = 2` are the same shape.
Prefer emitting parameterized `db.query.text` (the OTel spec says parameterized
text should **not** be sanitized) so shapes stay clean.

## Correlating server-side query logs with traces (SQLCommenter)

The client span above captures the query *as the caller sees it* — duration and
the query text — but it cannot see server-side detail such as memory used or
rows/bytes scanned. To bridge that gap, tag your queries with **SQLCommenter**,
the OpenTelemetry-standard way to propagate trace context into the database by
appending a comment to the query:

```sql
SELECT * FROM events WHERE ts > ? /*traceparent='00-<trace_id>-<span_id>-01'*/
```

Most OTel database instrumentations can inject this for you (it is opt-in — see
your SDK's SQLCommenter / "DB statement comment" option). Because the database
records the full query text — comment included — in its query log, Maple can
read that log back (see the ClickHouse integration) and stitch each server-side
query to the exact client span that issued it, nesting it as a child in the
trace.

> Note: SQLCommenter comments are low-cardinality-unfriendly for MySQL prepared
> statements, Oracle, and SQL Server; consult the OTel guidance before enabling
> it broadly on those engines.

## Resource allocation (ClickHouse)

Server-side **resource allocation** — peak memory, rows/bytes read, CPU time,
ProfileEvents — is not available from client spans. For ClickHouse, connect your
cluster via the ClickHouse integration: Maple polls `system.query_log`, forwards
each sampled query into Maple as a span (nested under your app's trace via the
SQLCommenter `traceparent` above) plus aggregate metrics, so query timing and
resource allocation land alongside your existing traces and dashboards.
