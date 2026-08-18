# Maple v2 Public API

The Maple v2 API is the public, documented, stability-committed HTTP surface for customer-stable Maple resources and workflows. It follows Stripe's API design philosophy — resource-oriented URLs, prefixed object IDs, uniform list/error envelopes, scoped keys — modernized where Stripe's v1 mechanics are legacy (JSON PATCH updates instead of form-encoded POST, ISO-8601 timestamps instead of epoch seconds).

The **executable contract is the spec**: `MapleApiV2` in `packages/domain/src/http/v2/` (an Effect `HttpApi`). OpenAPI is derived from it automatically and served as an interactive reference at **`/v2/docs`**. This document is the design-guideline layer every v2 contract file must conform to, plus the roadmap for the full surface.

## Architecture: two tiers

| Tier             | Transport                                                       | Consumers                            | Docs                        | Stability                                    |
| ---------------- | --------------------------------------------------------------- | ------------------------------------ | --------------------------- | -------------------------------------------- |
| **Public API**   | `MapleApiV2` HttpApi at `/v2/...`                               | Customers, agents/MCP, the dashboard | `/v2/docs` (OpenAPI/Scalar) | Committed; changes are additive or versioned |
| **Internal RPC** | Effect RPC (`effect/unstable/rpc`) `RpcGroup`s served at `/rpc` | The dashboard only                   | none (private)              | None; changes freely                         |

Dashboard-only operations — billing checkout/portal, onboarding state, demo seeding, AI chat apply, digest subscription, AI-triage settings, raw warehouse queries, and the error-agent claim/heartbeat/release loop — belong in the internal RPC tier. They use the same tenant resolution and org scoping but are **not** HTTP API groups and never appear in the public OpenAPI. Everything else is public API, and the dashboard consumes the same `/v2` endpoints customers do.

The v1 API (`/api/...`) stays mounted while the dashboard migrates group-by-group; each v1 group is deleted once nothing consumes it. The audited group-by-group destination and removal gate live in [`http-api-migration.md`](http-api-migration.md). **The RPC tier is Phase 3 and not built yet** — `packages/domain/src/internal-rpc.ts` holds service-to-service schemas, not `RpcGroup`s — so until it exists the only two real homes for a new operation are v2 or the legacy v1 group it would extend. New surface goes to v2; v1 only grows where an existing v1 group already owns the resource.

### Integration endpoints: which tier

Integrations are the one family split across tiers, so the rule is explicit. **The OAuth handshake itself is never an API group in either tier**: the provider redirects a _browser_, so the callback is a raw `HttpRouter` route in `apps/api/src/routes/` that ends in a 302 back to the web app (see `SlackCallbackRouter`). What lands in an API group is the surrounding control surface — status, begin-install, uninstall, and provider resource lookups.

That control surface is public v2 when a **public v2 resource depends on it**, and internal otherwise. Slack qualifies: `/v2/alerts/destinations` accepts `type: "slack-bot"` with a required `channel_id`, and the bot token never leaves the server, so `GET /v2/integrations/slack/channels` is the only way any caller — customer, agent, or the dashboard — can discover a valid id. Withholding it would ship a public destination type nobody outside the dashboard could construct. `status` and `uninstall` come along because splitting one provider across two tiers costs more than it buys; `install` is documented as browser-oriented since a headless caller cannot finish the redirect.

Within that group the role requirement is not uniform. `install`, `uninstall`, and `channels` require the org-admin role; `status` does not, because the dashboard renders install state for every member. `channels` is gated because it lists private channels the bot has joined, which is workspace membership information rather than Maple state. The consequence is deliberate: a non-admin can still create a `slack-bot` destination through the API if they already know a `channel_id`, but they cannot enumerate ids to find one.

PlanetScale was the first promotion under that rule, and it shows what "a public dependency" means in practice: infrastructure-as-code setups drive `POST /v2/integrations/planetscale/metrics_token` — the one step the OAuth flow cannot cover, because PlanetScale's metrics endpoints authenticate with service tokens rather than OAuth bearers — and a scripted caller needs a scoped API key, which only v2 has. Once one operation of a provider is public the rest follows: splitting one provider across two tiers costs more than it buys, so the whole surface moved (status, connect, organization binding, disconnect, inventory, webhook config, query insights, events). The role split matches Slack's — `status`, `databases`, `query_insights`, and `events` are ungated because the dashboard and service map render them for every member; everything that writes, plus `organizations` and `webhook_config` (it carries the signing secret), requires org-admin.

Promotion does not imply deletion. PlanetScale's v1 endpoints stay mounted and are marked `deprecated` in the v1 OpenAPI: the dashboard is off them, so nothing in this repo would notice if they broke, but customers may still be calling them. The general rule in the tier table above — "each v1 group is deleted once nothing consumes it" — means _nothing_, including callers outside this repo, so a promoted provider's v1 surface is removed only once its access logs go quiet. Until then both surfaces are live over the same services, and only v2 gets new work.

Cloudflare, GitHub, and Hazel stay on the v1 `integrations` group (`/api/integrations`) with no v2 counterpart — they predate v2, nothing public depends on them, and per the rule above they get promoted individually if and when something does. Scope families are derived mechanically from the first path segment under `/v2`, so every provider mounted at `/v2/integrations/<provider>` shares the `integrations:read` / `integrations:write` family.

Two things never move with a provider, no matter how much of it is promoted: the OAuth **callback** and any webhook **receiver**. Both are raw `HttpRouter` routes under `/api/…` serving a browser redirect or a provider POST, and a receiver URL is already registered in the provider's settings. So `POST /v2/integrations/planetscale/connect` still mints a `/api/integrations/planetscale/callback` URL, and `webhook_config` still reports a `/api/…` receiver. That is the intended end state, not leftover v1.

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

Prefixes: `key` (API key), `ingk` (ingest key), `dash` (dashboard), `dbv` (dashboard version), `dtpl` (dashboard template), `alrt` (alert rule), `dest` (alert destination), `inc` (alert incident), `evt` (alert delivery event), `einc` (error incident), `iss` (error issue), `inv` (investigation), `anom` (anomaly incident), `scrp` (scrape target), `rec` (recommendation), `amap` (attribute mapping), `srep` (session replay), and `log` (synthetic log identity); `we` is reserved for webhooks.

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

Every error response body uses this envelope:

```json
{
	"error": {
		"_tag": "@maple/http/investigations/InvestigationNotFoundError",
		"type": "not_found_error",
		"code": "investigation_not_found",
		"title": "Investigation not found",
		"message": "No such investigation.",
		"retryable": false,
		"recovery": "none",
		"param": "id"
	}
}
```

- `type` is closed: `invalid_request_error` (400), `authentication_error` (401), `permission_error` (403), `not_found_error` (404), `conflict_error` (409), `rate_limit_error` (429), `api_error` (500/502/503/504).
- `_tag` is required and is the stable semantic identity of the failure. Maple clients branch on it directly. Each operation's OpenAPI response is an `anyOf` of the literal tags that operation can actually return; `_tag: string` and generic status-family schemas are not valid endpoint contracts. Adding a new safe, documented tag is preferable to collapsing distinct failures into a generic unavailable/not-found error. Errors created at the v2 boundary use an explicit `defineV2Error` definition whose constructor and literal-tag schema cannot drift apart.
- `code` is a compact presentation category (`api_key_not_found`, `alert_destination_in_use`, `integration_upstream_error`, `parameter_invalid`, …). Several semantic tags may share a code, and a code may change when errors are regrouped. Clients that need exact branching use `_tag`.
- `title` and `message` are safe, human-readable presentation copy. `retryable` says whether the same logical request can plausibly succeed later without correcting its input; automatic mutation replay still requires an idempotency key. `recovery` is one of `none`, `fix_request`, `reauthenticate`, `request_access`, `reconnect`, `refresh`, `retry`, or `contact_support`.
- `retry_after_seconds` carries a relative delay; `retry_at` carries a known absolute reset time. When either is present the response also emits the standard `Retry-After` header.
- `param` names the offending parameter when applicable. On a request-decode failure it carries the full JSON path of the bad value (`widgets[3].display.chart_presentation.fill_nulls`), and for a path inside a `widgets[]` array the `message` also names the enclosing widget's `id`.
- Stack traces, driver messages, raw provider responses, and diagnostic causes never appear on the wire. `_tag` is an intentionally public semantic tag, not a leaked runtime class name.
- Expected failures remain distinct tagged errors through the service and route. Unexpected defects are logged with the group and operation, then returned as a sanitized `api_error` / `internal_error`; dependency messages are never copied to public 5xx responses.

Implementation: `packages/domain/src/http/error-policy.ts`, `packages/domain/src/http/v2/public-error.ts`, and `packages/domain/src/http/v2/errors.ts`. Request-decode failures are rewritten into the envelope with a structured `param` by `V2SchemaErrors`, while response-encoding schema failures are logged and sanitized as 500 because they are server contract bugs, not bad requests. `V2UnexpectedErrors` provides the defect boundary (`apps/api/src/routes/v2/error-envelope.ts`). Both transport middleware are attached once by `MapleApiV2`, so a new group cannot accidentally omit either boundary.

Each expected domain error class is created with `HttpTaggedError` and owns its tag, status, stable code, safe copy policy, retry behavior, and recovery action. The error instance exposes its own safe `error` body from that policy, and `publicError(ErrorClass)` derives the endpoint's exact wire schema from the same definition. Static code, title, safe message, retryability, and recovery values are literals in OpenAPI as well as at runtime. Handlers fail with the original tagged error; there is no generic route-level serializer, remapper, or second per-domain presentation table at the HTTP boundary. A route may still deliberately translate a parsing failure or a response-size limit into the endpoint-specific error that describes it. `exposure: "redacted"` requires separate Maple-authored copy at compile time, while the original internal failure remains available for logs and tracing. Boundary-only failures use `defineV2Error` and are emitted through that definition's `make` constructor.

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
- Within v2, resource shapes evolve additively. Error `_tag` values are the compatibility identity; `code`, title, message, recovery hints, and the broad HTTP category are presentation and may be corrected without minting a new API version.
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

| Resource                             | Endpoints                                                                                                                              | Backing service                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `api_keys` ✅ pilot                  | list/create/retrieve/roll/revoke, `scopes` param                                                                                       | `ApiKeysService`                                                                |
| `ingest_keys` ✅                     | retrieve, `POST …/public/roll`, `POST …/private/roll`                                                                                  | `OrgIngestKeysService`                                                          |
| `dashboards` ✅                      | CRUD + `versions` (list/retrieve/restore) + `templates` (list/preview/instantiate) + Perses import                                     | `dashboards`                                                                    |
| `alerts/rules` ✅                    | CRUD + `test` + `preview` + `checks`                                                                                                   | `AlertsService`                                                                 |
| `alerts/destinations` ✅             | CRUD + `test`                                                                                                                          | `AlertsService`                                                                 |
| `alerts/incidents` ✅                | list/retrieve                                                                                                                          | `AlertsService`                                                                 |
| `alerts/deliveries` ✅               | list delivery attempts                                                                                                                 | `AlertsService`                                                                 |
| `error_issues` 🟡                    | list/retrieve ✅; `events`, `comments`, `transitions`, `assignee`, `severity` deferred                                                 | `errors`                                                                        |
| `investigations` ✅                  | list/retrieve/create/status                                                                                                            | `InvestigationService`                                                          |
| `anomalies` ✅                       | incidents list/retrieve/timeseries/resolve/link-issue, `service_counts` aggregate + `PATCH` settings                                   | `anomalies`                                                                     |
| `instrumentation/recommendations` ✅ | list + dismiss/reopen                                                                                                                  | `RecommendationIssueService`                                                    |
| `instrumentation/audit` ✅           | retrieve (singleton report, recomputed per request)                                                                                    | `SetupAuditService`                                                             |
| `scrape_targets` ✅                  | CRUD + `probe` + `checks`                                                                                                              | `ScrapeTargetsService`                                                          |
| `attribute_mappings` ✅              | CRUD                                                                                                                                   | `IngestAttributeMappingService`                                                 |
| `integrations/slack` ✅              | status + admin-only install/uninstall/`channels` (channel ids for `slack-bot` destinations)                                            | `SlackIntegrationService`                                                       |
| `integrations/planetscale` ✅        | status + connect/organizations/`select_organization`/`metrics_token`/disconnect + databases/`webhook_config`/`query_insights`/`events` | `PlanetScaleConnectionService`, `PlanetScaleOAuthService`, `PlanetScaleService` |
| `session_replays` ✅                 | `search`/retrieve + events/transcript/`for_trace` (reduced; `facets`/`trace-summaries` deferred)                                       | `sessionReplays`                                                                |
| `mobile_devices` ✅                  | list (mine) / `PUT …/{token}` register-or-refresh / `DELETE …/{token}`; per user, per org; drives push fan-out                         | `MobileDevicesService`                                                          |
| `organization` 🟡                    | retrieve (GET only shipped); update settings (incl. ClickHouse BYOC) + delete deferred                                                 | `organizations`, `orgClickHouseSettings`                                        |
| `traces` ✅                          | search/timeseries/breakdown + direct trace/span reads                                                                                  | `queryEngine`, `observability`                                                  |
| `logs` ✅                            | search/timeseries/breakdown + direct log reads                                                                                         | `queryEngine`                                                                   |
| `metrics` ✅                         | catalog + timeseries/breakdown                                                                                                         | `queryEngine`                                                                   |
| `services` ✅                        | `GET /v2/services`, `GET /v2/services/{name}`                                                                                          | `queryEngine`                                                                   |
| `service_map` ✅                     | `GET /v2/service_map`                                                                                                                  | `queryEngine`                                                                   |

The long tail of ~40 query-engine endpoints (facets, infra hosts/pods/nodes/workloads, Cloudflare infra, the PlanetScale infra timeseries) lives in the internal tier at `/internal/query-engine`, session-only and undocumented, and is promoted into `/v2` individually as shapes stabilize.

### Telemetry reads

Phase 2 exposes traces, logs, metrics, services, and the service map. Telemetry search and aggregation requests require explicit ISO-8601 UTC `start_time` and `end_time`. Search windows are capped at 7 days, timeseries at 31 days and 1,500 buckets, and breakdowns at 30 days. A breakdown over 24 hours requires an additional narrowing filter. Direct trace/span retrieval uses the `(OrgId, TraceId, SpanId)` sorting-key prefix so it returns the complete retained trace without a correctness-limiting timestamp window. Direct log retrieval derives its narrow partition window from the timestamp embedded in the log ID.

Trace IDs, span IDs, metric names, and service names remain their native OpenTelemetry identifiers. Logs have no native record ID, so search results return a deterministic `log_…` ID containing a compact timestamp and a complete-record fingerprint. Malformed log IDs return `log_id_invalid`; records outside retention return `log_not_found`.

All telemetry lists use the standard cursor envelope with a default limit of 20 and maximum of 100. Trace search filters match any span by default and return the owning trace's root summary; `filters.span_scope: "root"` restricts matching to root spans. Trace results are ordered by start time and trace ID. Log ordering includes timestamp plus the complete composite identity. Attribute filters support equality, existence, substring, and numeric comparisons with optional negation; each attribute-filter collection is capped at 20 entries.

Each signal has explicit `POST …/timeseries` and `POST …/breakdown` operations. Requests use `aggregation`, optional scalar `group_by` for timeseries, required `group_by` for breakdowns, and nested `filters`. Timeseries responses contain chronological `series[].points`; breakdown responses contain ordered `data` entries. Inactive fields and query-engine terminology are never returned. Metric `rate` and `increase` require `metric_type: "sum"`; Apdex defaults to a 500 ms threshold.

Telemetry scope families are `traces`, `logs`, `metrics`, `services`, and `service_map`. Search, timeseries, and breakdown POSTs are read-only operations for scope enforcement, so the corresponding `<family>:read` scope is sufficient. There is no generic `/v2/query`, raw SQL, facet, attribute-discovery, or raw OTel datapoint endpoint.

Not in v2: org membership and invitations (delegated to Clerk; revisit if/when a members API is needed).

### Optional ElectricSQL `txid` metadata

The dashboard can reconcile optimistic writes against ElectricSQL synced shapes using a Postgres `txid` on mutation responses (dashboards, alert rules/destinations, error issues). The field is optional because v2 is a public API: callers neither provide nor require it, and non-ElectricSQL consumers can ignore it. When the persistence path exposes a transaction ID, Maple includes it as opaque reconciliation metadata.

## Rollout phases

- **Phase 0 (this change)** — conventions doc, v2 primitives (`public-id`, `envelopes`, `errors`, `auth`), scoped API keys (schema + service + enforcement), `MapleApiV2` shell mounted at `/v2` with Scalar docs at `/v2/docs`, pilot resource `api_keys` end-to-end with tests.
- **Phase 1 — core resources**: dashboards, alerts, error issues, scrape targets, ingest keys, attribute mappings, investigations, anomalies, recommendations, organization, session replays. Thin handler adapters over existing services; `txid` preserved.
- **Phase 2 ✅ — telemetry reads**: signal-scoped traces/logs/metrics query operations plus services/service_map over `QueryEngineService`.
- **Phase 3 — internal RPC tier + dashboard migration**: `RpcGroup` contracts in `packages/domain/src/rpc/` served at `/rpc`; dashboard gets a `MapleApiV2AtomClient` (same wiring as `apps/web/src/lib/services/common/atom-client.ts`, pointed at `MapleApiV2`) plus an `RpcClient`; migrate group-by-group, deleting v1 groups as they empty. (Note: the billing-scoped 401 retry in `atom-client.ts` must follow billing to its RPC home.)
- **Phase 4 — hardening**: `Idempotency-Key`, `Maple-Version` header enforcement. Per-key rate limiting is implemented.
- **Phase 5 — events & webhooks**: `evt_` event objects, `GET /v2/events`, `/v2/webhook_endpoints` CRUD, HMAC-signed deliveries (`Maple-Signature`) via an outbox drained by the alerting worker.

## Adding a v2 resource (checklist)

1. Contract in `packages/domain/src/http/v2/<resource>.ts`: snake_case wire schemas with an `object` literal and validated `Timestamp` fields; public IDs via `PublicId(prefix, InternalId)` (register the prefix in `public-id.ts`); lists use `ListQuery` + `ListOf`; every endpoint lists its exact error schemas with `publicError(ErrorClass)` and/or explicit boundary definitions (shared exhaustive sets such as `V2WarehouseErrors` are fine); group `.prefix("/v2/<resource>")` + `.middleware(AuthorizationV2)`. Request-validation, authorization, and unexpected-error middleware contribute their own exact tags API-wide; do not attach them per group.
2. Add the group to `MapleApiV2` in `v2/api.ts` and export from `v2/index.ts`.
3. Define expected failures with `HttpTaggedError` in the domain contract. Put their public status, code, safe-copy policy, retry behavior, and recovery action on the class.
4. Handlers in `apps/api/src/routes/v2/<resource>.http.ts`: thin adapters over the existing service — map camelCase/epoch-ms service responses to the wire model and let expected tagged errors pass through unchanged. Register the layer in `ApiV2Routes` (`apps/api/src/runtime/http-graph.ts`).
5. Tests: wire-shape encode (snake_case, public ID, envelope), public error serialization/redaction, and a PGlite service test if the service changed.
6. Confirm the resource renders correctly at `/v2/docs`.
