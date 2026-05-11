# Span attribute reference

The canonical list of custom span attribute keys Maple emits, grouped by namespace. **Use these exact spellings in every language** — Title Case status, dotted-lowercase keys (with the documented camelCase exceptions for the tenant block).

Columns:
- **Key** — exact attribute name to emit
- **Type** — JSON type (`string`, `int`, `bool`)
- **Set at** — file:line that proves the convention (canonical example)
- **Meaning** — one-line description

---

## ⭐ `WarehouseQueryService.executeSql` — canonical span

Every SQL execution against Tinybird or ClickHouse emits these. When you add a new attribute to a query path, prefer extending this block over inventing a parallel set.

Source: `apps/api/src/services/WarehouseQueryService.ts:441-510`

| Key | Type | Set at | Meaning |
|---|---|---|---|
| `orgId` | string | `WarehouseQueryService.ts:448` | Tenant org UUID (camelCase — historical, do not rename) |
| `tenant.userId` | string | `WarehouseQueryService.ts:449` | User ID within the tenant |
| `tenant.authMode` | string | `WarehouseQueryService.ts:450` | `"api_key"` / `"user_login"` / etc. |
| `clientSource` | string | `WarehouseQueryService.ts:373, 387` | `"org_override"` or `"managed"` (which config resolved) |
| `db.client` | string | `WarehouseQueryService.ts:374, 389, 405` | `"clickhouse"` or `"tinybird-sdk"` |
| `db.system` | string | `WarehouseQueryService.ts:462` | `"clickhouse"` or `"tinybird"` |
| `db.statement` | string | `WarehouseQueryService.ts:471` | Full compiled SQL, truncated to 16 KB |
| `db.statement.length` | int | `WarehouseQueryService.ts:472` | Pre-truncation byte length |
| `db.statement.truncated` | bool | `WarehouseQueryService.ts:473` | Whether SQL was capped at 16 KB |
| `db.statement.fingerprint` | string | `WarehouseQueryService.ts:474` | 32-bit FNV-1a hash with literals + numbers normalized |
| `db.duration_ms` | int | `WarehouseQueryService.ts:489, 508` | Execution time in ms (emitted on both success and error tap) |
| `query.pipe` | string | `WarehouseQueryService.ts:475` | Original pipe name passed to `sqlQuery()` |
| `query.context` | string | `WarehouseQueryService.ts:476` | Semantic call-site label (e.g. `"errorsByType"`, `"spanHierarchy"`). Set via `SqlQueryOptions.context`. |
| `query.profile` | string | `WarehouseQueryService.ts:477` | Execution profile (e.g. `"list"`, `"analytics"`). Set via `SqlQueryOptions.profile`. |
| `ch.settings` | string (JSON) | `WarehouseQueryService.ts:478` | JSON-encoded ClickHouse settings applied to the query |
| `result.rowCount` | int | `WarehouseQueryService.ts:507` | Number of rows returned |

**Rule:** When adding a new query, always pass a `context` string to `SqlQueryOptions` — it becomes filterable as `query.context` in trace search. Don't invent new keys when one of `query.*` fits.

---

## `db.*` group (general)

Beyond `executeSql`, the same `db.system` / `db.duration_ms` keys appear wherever Maple talks to a warehouse. Add any new DB-related attrs under `db.*` — never under `database.*` or `clickhouse.*`.

---

## `query.*` group (DSL query metadata)

Used by `packages/query-engine` and `apps/api/src/services/QueryEngineService.ts` for the higher-level DSL surface (not raw SQL).

| Key | Type | Meaning |
|---|---|---|
| `query.pipe` | string | Pipe / DSL function name |
| `query.context` | string | Semantic call-site label |
| `query.profile` | string | Execution profile (`"list"`, `"analytics"`, etc.) |
| `query.kind` | string | `"timeseries"` / `"breakdown"` / `"list"` |
| `query.metric` | string | Metric being queried (e.g. `"count"`, `"error_rate"`) |
| `query.source` | string | `"traces"` / `"logs"` / `"metrics"` |
| `query.reducer` | string | Aggregation function (e.g. `"sum"`, `"avg"`) |
| `query.bucketSeconds` | int | Bucket size for timeseries queries |
| `query.filter.serviceName` | string | Filter value for serviceName |
| `query.filter.spanName` | string | Filter value for spanName |
| `query.filter.metricName` | string | Filter value for metricName |

---

## `result.*` group

| Key | Type | Set at | Meaning |
|---|---|---|---|
| `result.rowCount` | int | `WarehouseQueryService.ts:507` | Rows returned by a query |
| `result.groupCount` | int | QueryEngineService | Distinct groups in a breakdown |

---

## `tenant.*` group

| Key | Type | Set at | Meaning |
|---|---|---|---|
| `tenant.userId` | string | `WarehouseQueryService.ts:449` | User ID within the tenant |
| `tenant.authMode` | string | `WarehouseQueryService.ts:450` | Authentication mode |

**Naming inconsistency to preserve:** `orgId` is camelCase, `tenant.userId` is dotted-lowercase. This is historical — `orgId` predates the `tenant.*` namespace and renaming it would break existing trace search filters and dashboard queries. Do not unify them.

---

## `cache.*` group

Emitted by `BucketCacheService` (timeseries cache) and the EdgeCache wrappers. Used to debug cache hit ratios and pinpoint dedup behavior.

Source: `apps/api/src/services/BucketCacheService.ts`, `apps/api/src/services/QueryEngineService.ts`

| Key | Type | Set at | Meaning |
|---|---|---|---|
| `cache.fingerprint` | string | `BucketCacheService.ts:314` | First 12 chars of cache key fingerprint |
| `cache.hit` | bool | `QueryEngineService.ts:1694, 1806, 1830` | Cache hit or miss |
| `cache.ttlSeconds` | int | `QueryEngineService.ts:1695` | TTL of cached entry |
| `cache.bucketsHit` | int | `QueryEngineService.ts:1745` | Matching buckets from cache (bucket cache) |
| `cache.bucketsMissed` | int | `QueryEngineService.ts:1746` | Missing buckets (bucket cache) |
| `cache.missingRangeCount` | int | `BucketCacheService.ts:456`, `QueryEngineService.ts:1747` | Count of contiguous missing time ranges |
| `cache.existingBucketCount` | int | `BucketCacheService.ts:457` | Pre-existing buckets in cache |
| `cache.bucketSeconds` | int | `BucketCacheService.ts:477` | Bucket size for this cache request |
| `cache.rangeMs` | int | `BucketCacheService.ts:478` | Request time-range span in ms |
| `cache.dedup.waited` | bool | `BucketCacheService.ts:366` | Whether this request waited on an in-flight peer |

---

## `email.*` group

Emitted by `EmailService` for outbound transactional email.

Source: `apps/api/src/services/EmailService.ts`

| Key | Type | Set at | Meaning |
|---|---|---|---|
| `email.to` | string | `EmailService.ts:27` | Recipient address |
| `email.subject` | string | `EmailService.ts:28` | Subject line |
| `email.provider` | string | `EmailService.ts:29` | `"resend"` (current provider) |
| `http.status_code` | int | `EmailService.ts:70` | Provider HTTP response status (non-semconv shortcut used by EmailService only — new code should use `http.response.status_code`) |

---

## `maple.*` vendor namespace (ingest gateway)

Custom domain attributes for the Rust ingest gateway. All `maple.*` keys are reserved for Maple-specific metadata that has no OTel semconv equivalent.

Source: `apps/ingest/src/main.rs:843-861` (inbound signal span), `:920-937` (Cloudflare logpush), `:1132-1145` (downstream forward).

### `maple.signal`
- **Type:** string (`"traces"`, `"logs"`, `"metrics"`)
- **Set at:** `apps/ingest/src/main.rs:853, 930, 1143, 1308`
- **Meaning:** Which OTel signal this request carries.

### `maple.org_id`
- **Type:** string
- **Set at:** `apps/ingest/src/main.rs:854, 931, 1203`
- **Meaning:** Resolved organization ID from the ingest key.
- **⚠ Note:** In Rust this is `maple.org_id` (vendor-namespaced). In TypeScript (`WarehouseQueryService.ts:448`) it's `orgId` (camelCase, no namespace). Both are intentional — trace search filters in dashboards already expect both spellings.

### `maple.ingest.*` sub-namespace

| Key | Type | Set at | Meaning |
|---|---|---|---|
| `maple.ingest.key_type` | string | `main.rs:855` | `"public"` / `"private"` / `"sentinel"` / `"connector"` |
| `maple.ingest.self_managed` | bool | `main.rs:856, 935, 1204` | Org using self-managed Tinybird |
| `maple.ingest.payload_format` | string | `main.rs:857` | `"otlp_json"` / `"otlp_protobuf"` / `"cloudflare_json"` |
| `maple.ingest.content_encoding` | string | `main.rs:858` | `"gzip"` / `"deflate"` / `""` |
| `maple.ingest.decoded_bytes` | int | `main.rs:859` | Size after decompression |
| `maple.ingest.item_count` | int | `main.rs:860, 936, 950` | Spans / logs / metrics in the payload |
| `maple.ingest.upstream_pool` | string | `main.rs:1144, 1309` | `"shared"` / `"self_managed"` (downstream collector pool) |

### `maple.cloudflare.*` sub-namespace

| Key | Type | Set at | Meaning |
|---|---|---|---|
| `maple.cloudflare.connector_id` | string | `main.rs:932` | Cloudflare Logpush connector UUID |
| `maple.cloudflare.dataset` | string | `main.rs:933` | `"http_requests"` (only value today) |
| `maple.cloudflare.is_validation` | bool | `main.rs:934, 951` | Whether this is a Cloudflare validation ping |

---

## HTTP semconv (ingest gateway)

The Rust ingest gateway emits the canonical OTel HTTP semconv keys on its Server-kind and Client-kind spans. **Use these exact keys; do not invent `http.method` (legacy) or `http.url` in new code.**

| Key | Direction | Set at | Meaning |
|---|---|---|---|
| `http.request.method` | both | `main.rs:848, 925, 1137, 1302` | Always `"POST"` for ingest |
| `http.route` | server | `main.rs:849, 926` | Logical route (`"/v1/traces"`, `"/v1/logpush/cloudflare/http_requests/{connector_id}"`) |
| `http.request.body.size` | both | `main.rs:850, 927, 1138, 1303` | Request body size in bytes |
| `http.response.status_code` | both | `main.rs:851, 873, 893, 928, 948, 976, 1139, 1304` | Final HTTP status code |
| `error.type` | server, client | `main.rs:852, 894, 929, 977, 1142, 1307` | Error category: `"validation"` / `"auth"` / `"upstream"` / `"decode"` / `"forward"` etc. |
| `url.full` | client | `main.rs:1140, 1305` | Full downstream collector URL |
| `server.address` | client | `main.rs:1141, 1306` | Downstream collector host |

The Rust `tracing` macro reserves field names with dots only when quoted: `"http.request.method" = "POST"`. The Rust ingest gateway also uses `otel.name`, `otel.kind`, `otel.status_code` field names — see `rules/status-and-kind.md`.

---

## Misc attributes (call-site-specific)

These appear on individual span functions but are not part of a reusable namespace. Inventoried here so you don't accidentally invent parallel keys.

| Key | Type | Where | Meaning |
|---|---|---|---|
| `datasource` | string | `WarehouseQueryService.ts:571` | Datasource being ingested into |
| `rowCount` | int | `WarehouseQueryService.ts:573` | Rows in ingest payload |
| `pipe` | string | `WarehouseQueryService.ts:517` | Pipe name (legacy `query()` method) |
| `attributeKey` | string | attribute-explore routes | Attribute key being browsed |
| `service` | string | many routes | Service name from query params (note: not `service.name` — that's a resource attribute) |
| `spanId` | string | trace detail | Span being inspected |
| `traceId` | string | trace detail | Trace being inspected |
| `userId` | string | various | User ID context |
| `limit` | int | listing routes | Result limit |
| `rootOnly` | bool | trace queries | Filter to root spans only |
| `incidentCount`, `issueCount`, `errorCount`, `serviceCount`, `orgCount`, `eventCount`, `sentCount`, `totalRequests`, `totalErrors`, `resultCount` | int | various | Result-shape counters on enclosing routes |

**Rule:** Prefer extending an existing namespace (`query.*`, `result.*`, `cache.*`) over adding a new bare key. New bare keys make trace search harder.
