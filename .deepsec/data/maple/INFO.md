# maple

## What this codebase does

Maple is a multi-tenant OpenTelemetry observability platform. A TanStack
Start SPA (`apps/web`) talks to an Effect HTTP API (`apps/api`, deployed
on Cloudflare Workers + D1), which proxies queries to a warehouse
(Tinybird SDK or self-hosted ClickHouse). A Rust ingest gateway
(`apps/ingest`) accepts OTLP from customer apps after key auth and
forwards to the OTel collector. An MCP server lives under `/mcp` of the
API for AI-agent access; a Cloudflare Workers chat agent
(`apps/chat-agent`) talks to it.

## Auth shape

- **Two modes via `MAPLE_AUTH_MODE`:** `clerk` (Clerk SaaS, verified via
  `@clerk/backend.authenticateRequest`) or `self_hosted` (single
  `MAPLE_ROOT_PASSWORD` — that password is **also the HS256 JWT signing
  secret**; tokens are minted by `loginSelfHosted`).
- **Entry point:** `AuthService.resolveTenant(headers)` returns
  `TenantContext { orgId, userId, roles, authMode }`. Wired into routes
  through `CurrentTenant.Authorization` (`AuthorizationLive`) — handlers
  read `yield* CurrentTenant.Context`.
- **MCP variant:** `AuthService.resolveMcpTenant` accepts `api_key`
  tokens; `ApiKeysService.resolveByKey` looks them up by HMAC hash
  (`MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY`).
- **Admin gating:** ad-hoc `requireAdmin(roles)` checks for `"root"` or
  `"org:admin"` in `routes/integrations.http.ts`,
  `OrganizationService`, `OrgOpenRouterSettingsService`. There is no
  central middleware for this — every admin route opts in.
- **Warehouse scoping:** `WarehouseQueryService.sqlQuery` refuses any
  SQL that does not literally contain `"OrgId"`. This is the only
  tenant guard between the API and the warehouse — bypassing it
  bypasses tenancy.
- **Ingest keys (per-org, public + private):** generated in
  `OrgIngestKeysService`. Private keys are AES-256-GCM-encrypted at
  rest (`MAPLE_INGEST_KEY_ENCRYPTION_KEY`); lookup is by HMAC hash. The
  Rust gateway does its own HMAC-based key auth before forwarding OTLP.
- **chat-agent has a parallel `verifyRequest`** in
  `apps/chat-agent/src/lib/auth.ts` that re-implements both Clerk and
  the self-hosted HS256 path — drift between the two implementations
  would be a real bug.

## Threat model

Highest impact: **cross-tenant data leakage** through warehouse queries
that skip `WarehouseQueryService.sqlQuery` or build SQL without an
`OrgId` filter. **Self-hosted mode** is unusual — the root password
doubles as the JWT signing key, so password disclosure = unlimited
session forgery. Ingest-key disclosure (especially private keys) lets
an attacker forge OTLP telemetry into another org. The MCP endpoint and
its OAuth discovery routes are intentionally public surfaces; bypasses
in `resolveMcpTenant` or in the api-key lookup are critical.

## Project-specific patterns to flag

- Warehouse access that **bypasses `WarehouseQueryService.sqlQuery`** —
  raw `fetch()` to `/v0/sql`, direct `createClickHouseClient` /
  `Tinybird` SDK calls, or `executeSql` callers that omit an `OrgId`
  filter in the compiled SQL.
- HTTP handlers under `apps/api/src/routes/*.http.ts` that **do not
  read `CurrentTenant.Context`** before passing data to a service, or
  that pass a tenant orgId from the request body/params instead of from
  `CurrentTenant`.
- Admin-mutating operations that **don't call `requireAdmin`** /
  inspect `tenant.roles` for `root` / `org:admin` — especially in new
  files under `routes/` and new methods in `Organization*Service`.
- New code that signs/verifies session JWTs with anything other than
  `verifyHs256Jwt` / `signHs256Jwt` from `AuthService`, or that
  compares secrets with `===` instead of `constantTimeEquals` /
  `timingSafeEqual`.
- AES-GCM helpers in `services/Crypto.ts` reused with a non-32-byte
  key, a static IV, or a key sourced from anywhere other than
  `MAPLE_INGEST_KEY_ENCRYPTION_KEY`.

## Known false-positives

- `routes/auth.http.ts` (`HttpAuthPublicLive`) — `/auth/login` is
  unauthenticated by design; it's the endpoint that mints the bearer.
- `routes/oauth-discovery.http.ts`, `/health`, `/docs`, GET `/mcp`,
  `/.well-known/*`, `POST /register` — intentionally public.
- `routes/demo.http.ts` + `services/DemoService.ts` —
  authenticated, but seeds synthetic OTLP into the caller's own org via
  the public ingest key on purpose.
- `apps/web/src/components/dashboard-builder/widgets/*` — render
  warehouse rows into Recharts/SVG; the apparent "user-controlled HTML"
  is a typed SQL result, not raw input.
- `apps/ingest` (Rust) deliberately accepts large gzipped OTLP bodies
  on `/v1/{traces,logs,metrics}` — `INGEST_MAX_REQUEST_BODY_BYTES` and
  the HMAC key check are the real boundary, not body size alone.
