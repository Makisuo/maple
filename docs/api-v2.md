# Maple v2 Public API

The Maple v2 API is the public, documented, stability-committed HTTP surface for everything the dashboard can do. It follows Stripe's API design philosophy — resource-oriented URLs, prefixed object IDs, uniform list/error envelopes, scoped keys — modernized where Stripe's v1 mechanics are legacy (JSON PATCH updates instead of form-encoded POST, ISO-8601 timestamps instead of epoch seconds).

The **executable contract is the spec**: `MapleApiV2` in `packages/domain/src/http/v2/` (an Effect `HttpApi`). OpenAPI is derived from it automatically and served as an interactive reference at **`/v2/docs`**. This document is the design-guideline layer every v2 contract file must conform to, plus the roadmap for the full surface.

## Architecture: two tiers

| Tier             | Transport                                                       | Consumers                            | Docs                        | Stability                                    |
| ---------------- | --------------------------------------------------------------- | ------------------------------------ | --------------------------- | -------------------------------------------- |
| **Public API**   | `MapleApiV2` HttpApi at `/v2/...`                               | Customers, agents/MCP, the dashboard | `/v2/docs` (OpenAPI/Scalar) | Committed; changes are additive or versioned |
| **Internal RPC** | Effect RPC (`effect/unstable/rpc`) `RpcGroup`s served at `/rpc` | The dashboard only                   | none (private)              | None; changes freely                         |

Dashboard-only operations — billing checkout/portal, onboarding state, demo seeding, AI chat apply, digest subscription, AI-triage settings, integration OAuth flows (Slack/Cloudflare/PlanetScale/GitHub), raw warehouse queries, and the error-agent claim/heartbeat/release loop — live in the internal RPC tier. They use the same tenant resolution and org scoping but are **not** HTTP API groups and never appear in the public OpenAPI. Everything else is public API, and the dashboard consumes the same `/v2` endpoints customers do.

The v1 API (`/api/...`) stays mounted while the dashboard migrates group-by-group; each v1 group is deleted once nothing consumes it.

## Conventions

### URLs and methods

Resources are snake_case plural nouns directly under `/v2`:

```
GET    /v2/api_keys              list
POST   /v2/api_keys              create
GET    /v2/api_keys/{id}         retrieve
DELETE /v2/api_keys/{id}         revoke (returns the final object)
POST   /v2/api_keys/{id}/roll    non-CRUD verbs are sub-resource POSTs
POST   /v2/traces/search         complex reads are POST .../search
```

### Object IDs

Every v2 object has a prefixed public ID (`key_4CzLmR…`, `dash_…`, `alrt_…`). Public IDs are opaque; internally they are a reversible base58 encoding of the internal ID, computed at the API boundary (`packages/domain/src/http/v2/public-id.ts` — the prefix registry lives there and is the single source of truth). No database migration: rows keep their raw UUIDs / internal strings.

Prefixes: `key` (API key), `ingk` (ingest key), `dash` (dashboard), `dbv` (dashboard version), `dtpl` (dashboard template), `alrt` (alert rule), `dest` (alert destination), `inc` (alert incident), `einc` (error incident), `iss` (error issue), `inv` (investigation), `anom` (anomaly incident), `scrp` (scrape target), `rec` (recommendation), `amap` (attribute mapping), `srep` (session replay), and `log` (synthetic log identity); `evt` and `we` are reserved for events/webhooks.

Exception: Clerk-issued `org_…` / `user_…` IDs are already prefixed public IDs and pass through unchanged.

A malformed or wrong-prefix ID fails request decoding and returns an `invalid_request_error`.

### Wire format

- **snake_case** JSON field names everywhere (`key_prefix`, `created_at`).
- Every resource carries **`object`** (`"api_key"`, `"dashboard"`, `"list"`, …).
- **Timestamps are ISO-8601 UTC strings** (`2026-07-15T12:34:56.000Z`).
- Nullable fields are explicit `null`, not omitted.

### Lists and pagination

Every list endpoint accepts `limit` (1–100, default 20) and an opaque `cursor`, and responds with the list envelope:

```json
{
	"object": "list",
	"data": [{ "...": "..." }],
	"has_more": true,
	"next_cursor": "off_1k"
}
```

`next_cursor` is `null` on the last page. Cursors are opaque — clients must not parse them. (Endpoints backed by keyset pagination and endpoints backed by materialized arrays use different cursor payloads; the wire contract is identical.)

Offset-backed endpoints fetch `limit + 1` rows from their backing store to determine `has_more`; they do not load a fixed history window and paginate it in memory. Every ordering has a deterministic tie-breaker.

### Errors

Every error response body is exactly:

```json
{
	"error": {
		"type": "not_found_error",
		"code": "api_key_not_found",
		"message": "API key not found",
		"param": "id"
	}
}
```

- `type` is closed: `invalid_request_error` (400), `authentication_error` (401), `permission_error` (403), `not_found_error` (404), `conflict_error` (409), `rate_limit_error` (429), `api_error` (5xx).
- `code` is a stable machine-readable string (`api_key_not_found`, `alert_destination_in_use`, `api_key_lookup_unavailable`, `insufficient_scope`, `parameter_invalid`, …). Resource and dependency failures identify the affected resource and operation. Codes are append-only.
- `param` names the offending parameter when applicable; `doc_url` may link to reference docs.
- No internal tags or stack traces ever appear on the wire.
- Expected internal failures use operation-specific tagged errors. Unexpected defects are logged with the group and operation, then returned as a sanitized `api_error` / `internal_error`; dependency messages are never copied to public 5xx responses.

Implementation: `packages/domain/src/http/v2/errors.ts`; request-decode failures are rewritten into the envelope with a structured `param` by `V2SchemaErrors`, and `V2UnexpectedErrors` provides the defect boundary (`apps/api/src/routes/v2/error-envelope.ts`).

### Authentication and scopes

```
Authorization: Bearer maple_ak_…
```

v2 accepts the same credentials as v1: API keys (`maple_ak_…`) and dashboard session tokens (Clerk or self-hosted JWT). API keys can be **restricted with scopes** at creation:

- Grammar: `<family>:read`, `<family>:write`, or `*`. The family is the first path segment under `/v2` (`api_keys`, `dashboards`, `alerts`, `error_issues`, `traces`, …).
- Enforcement is mechanical: `GET`/`HEAD` and explicitly declared read-only query POSTs (such as session-replay search, trace lookup, and alert preview) require `<family>:read`; mutations require `<family>:write`. `write` implies `read`.
- Keys with no scopes (all pre-v2 keys) have full access. Session tokens are never scope-checked — the dashboard's authorization comes from org roles, like Stripe's own dashboard.
- Failing the check returns `permission_error` / `insufficient_scope`.

Implementation: `packages/domain/src/http/v2/auth.ts` + `apps/api/src/services/ApiAuthorizationV2Layer.ts`; scopes are stored on `api_keys.scopes` (jsonb).

### Versioning

- The `/v2` path prefix is the major version. Breaking changes require `/v3`.
- Within v2, changes are additive (new endpoints, new optional fields, new enum values documented as open sets, new error codes).
- A `Maple-Version: YYYY-MM-DD` header is reserved for future in-v2 evolution; until multiple versions exist, it is accepted and ignored.

### Idempotency (Phase 4 — reserved)

Mutating endpoints will accept an `Idempotency-Key` header. Replays within the retention window return the original response. Backed by a Postgres `idempotency_keys` table keyed by `(org_id, key)`.

### Rate limiting

API-key-authenticated requests share one budget per key across the entire `/v2` surface: **600 requests per 60 seconds**. The budget is partitioned by deployment stage, and rolling a key starts a fresh budget because the replacement has a new internal key ID. Valid-key requests count even when a later scope or role check rejects them; invalid credentials and dashboard session tokens do not use this budget.

Exceeding the budget returns `429` with the standard error envelope (`type: "rate_limit_error"`, `code: "rate_limited"`) and `Retry-After: 60`. No remaining/reset headers are emitted because the backing Cloudflare binding returns only an allow/deny result.

The limiter fails open: if its binding is missing or errors, Maple logs and traces `maple.rate_limit.outcome=failed_open` and continues the request. Cloudflare counters are local to the location serving the Worker and eventually consistent, so this is abuse protection rather than exact global quota accounting.

### Expansion — not supported

Stripe-style `expand[]` is deliberately omitted: responses embed the small, always-wanted sub-objects directly. May be revisited once real client demand exists.

## Resource catalog (target surface)

Implemented in phases; the pilot (`api_keys`) ships first and proves every convention.

| Resource                             | Endpoints                                                                                          | Backing v1 group / service               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `api_keys` ✅ pilot                  | list/create/retrieve/roll/revoke, `scopes` param                                                   | `apiKeys` / `ApiKeysService`             |
| `ingest_keys` ✅                     | retrieve, `POST …/public/roll`, `POST …/private/roll`                                              | `ingestKeys`                             |
| `dashboards` ✅                      | CRUD + `versions` (list/retrieve/restore) + `templates` (list/instantiate) + Perses import         | `dashboards`                             |
| `alerts/rules` ✅                    | CRUD + `test` + `preview` + `checks`                                                               | `alerts`                                 |
| `alerts/destinations` ✅             | CRUD + `test`                                                                                      | `alerts`                                 |
| `alerts/incidents` ✅                | list/retrieve                                                                                      | `alerts`                                 |
| `error_issues`                       | list/retrieve + `events`, `incidents`, `comments`, `transitions`, `assignee`, `severity`           | `errors`                                 |
| `investigations` ✅                  | list/retrieve/create/status                                                                        | `investigations`                         |
| `anomalies` ✅                       | incidents list/retrieve/timeseries/resolve/link-issue + `PATCH` settings                           | `anomalies`                              |
| `instrumentation/recommendations` ✅ | list + dismiss/reopen                                                                              | `recommendationIssues`                   |
| `scrape_targets` ✅                  | CRUD + `probe` + `checks`                                                                          | `scrapeTargets`                          |
| `attribute_mappings` ✅              | CRUD                                                                                               | `ingestAttributeMappings`                |
| `session_replays` ✅                 | `search`/retrieve + events/transcript/`for_trace` (reduced; `facets`/`trace-summaries` deferred)   | `sessionReplays`                         |
| `organization` 🟡                    | retrieve (GET only shipped); update settings (incl. ClickHouse BYOC) + delete deferred             | `organizations`, `orgClickHouseSettings` |
| `traces` ✅                          | `POST /v2/traces/search`, `GET /v2/traces/{trace_id}`, `GET /v2/traces/{trace_id}/spans/{span_id}` | `queryEngine`, `observability`           |
| `logs` ✅                            | `POST /v2/logs/search`, `GET /v2/logs/{id}`                                                        | `queryEngine`                            |
| `metrics` ✅                         | `GET /v2/metrics`, `POST /v2/metrics/timeseries`                                                   | `queryEngine`                            |
| `services` ✅                        | `GET /v2/services`, `GET /v2/services/{name}`                                                      | `queryEngine`                            |
| `service_map` ✅                     | `GET /v2/service_map`                                                                              | `queryEngine`                            |
| `query` ✅                           | `POST /v2/query` — structured telemetry queries                                                    | `queryEngine`                            |

The long tail of ~40 query-engine RPC endpoints (facets, infra hosts/pods/nodes/workloads, Cloudflare/PlanetScale infra) starts in the internal RPC tier and is promoted into `/v2` individually as shapes stabilize.

### Telemetry reads

Phase 2 exposes traces, logs, metrics, services, the service map, and the common query engine. Collection and aggregation operations require explicit ISO-8601 UTC `start_time` and `end_time`; `end_time` must be later than `start_time`, and ranges are capped at 31 days. Direct trace/span retrieval uses the `(OrgId, TraceId, SpanId)` sorting-key prefix so it returns the complete retained trace without a correctness-limiting timestamp window. Direct log retrieval derives its narrow partition window from the timestamp embedded in the log ID.

Trace IDs, span IDs, metric names, and service names remain their native OpenTelemetry identifiers. Logs have no native record ID, so search results return a deterministic `log_…` ID containing a compact timestamp and a complete-record fingerprint. Malformed log IDs return `log_id_invalid`; records outside retention return `log_not_found`.

All telemetry lists use the standard cursor envelope with a default limit of 20 and maximum of 100. Trace results are root-span summaries ordered by start time and trace ID. Log ordering includes timestamp plus the complete composite identity. Services are grouped by service name across namespaces and deployment environments. The service map includes only service-to-service edges in this version; database, external, and infrastructure nodes remain internal APIs.

`POST /v2/query` accepts `timeseries` and `breakdown` specifications for trace, log, and metric sources using snake_case fields. Responses use the common `query_result` envelope. Raw SQL is intentionally unavailable through the public API because tenant isolation must not depend on inspecting caller-authored SQL text. Warehouse diagnostics are never returned to callers.

Telemetry scope families are `traces`, `logs`, `metrics`, `services`, `service_map`, and `query`. Search, timeseries, and query POSTs are read-only operations for scope enforcement, so `<family>:read` is sufficient.

Not in v2: org membership and invitations (delegated to Clerk; revisit if/when a members API is needed).

### Optional ElectricSQL `txid` metadata

The dashboard can reconcile optimistic writes against ElectricSQL synced shapes using a Postgres `txid` on mutation responses (dashboards, alert rules/destinations, error issues). The field is optional because v2 is a public API: callers neither provide nor require it, and non-ElectricSQL consumers can ignore it. When the persistence path exposes a transaction ID, Maple includes it as opaque reconciliation metadata.

## Rollout phases

- **Phase 0 (this change)** — conventions doc, v2 primitives (`public-id`, `envelopes`, `errors`, `auth`), scoped API keys (schema + service + enforcement), `MapleApiV2` shell mounted at `/v2` with Scalar docs at `/v2/docs`, pilot resource `api_keys` end-to-end with tests.
- **Phase 1 — core resources**: dashboards, alerts, error issues, scrape targets, ingest keys, attribute mappings, investigations, anomalies, recommendations, organization, session replays. Thin handler adapters over existing services; `txid` preserved.
- **Phase 2 ✅ — telemetry reads**: traces/logs/metrics/services/service_map/query over `QueryEngineService`.
- **Phase 3 — internal RPC tier + dashboard migration**: `RpcGroup` contracts in `packages/domain/src/rpc/` served at `/rpc`; dashboard gets a `MapleApiV2AtomClient` (same wiring as `apps/web/src/lib/services/common/atom-client.ts`, pointed at `MapleApiV2`) plus an `RpcClient`; migrate group-by-group, deleting v1 groups as they empty. (Note: the billing-scoped 401 retry in `atom-client.ts` must follow billing to its RPC home.)
- **Phase 4 — hardening**: `Idempotency-Key`, `Maple-Version` header enforcement. Per-key rate limiting is implemented.
- **Phase 5 — events & webhooks**: `evt_` event objects, `GET /v2/events`, `/v2/webhook_endpoints` CRUD, HMAC-signed deliveries (`Maple-Signature`) via an outbox drained by the alerting worker.

## Adding a v2 resource (checklist)

1. Contract in `packages/domain/src/http/v2/<resource>.ts`: snake_case wire schemas with an `object` literal and validated `Timestamp` fields; public IDs via `PublicId(prefix, InternalId)` (register the prefix in `public-id.ts`); lists use `ListQuery` + `ListOf`; errors from `v2/errors.ts` only; group `.prefix("/v2/<resource>")` + `.middleware(AuthorizationV2)` + `.middleware(V2SchemaErrors)`.
2. Add the group to `MapleApiV2` in `v2/api.ts` and export from `v2/index.ts`.
3. Handlers in `apps/api/src/routes/v2/<resource>.http.ts`: thin adapters over the existing service — map camelCase/epoch-ms service responses to the wire model, map service tagged errors to envelope errors. Register the layer in `ApiV2Routes` (`apps/api/src/app.ts`).
4. Tests: wire-shape encode (snake_case, public ID, envelope), error mapping, and a PGlite service test if the service changed.
5. Confirm the resource renders correctly at `/v2/docs`.
