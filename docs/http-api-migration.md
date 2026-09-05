# HTTP API migration and v1 retirement

Status: implementation plan, audited 2026-08-13; retirement sweep executed 2026-08-14.

This document decides where the remaining `/api/...` surface belongs and defines the gate for deleting it. The governing rule is consumer intent, not transport convenience:

- `/v2` is the stable public resource API for customers, agents, IaC, and the dashboard.
- `/internal` is the private dashboard transport for product workflows that can change with the UI. It is a separate `HttpApi` (`MapleInternalApi`), session-only via `SessionAuthorization`, and absent from `/docs`. It is deliberately NOT a distinct wire protocol: the boundary is who may call it, not how. Earlier drafts of this document called this tier `/rpc`; the name changed when it shipped, the intent did not.
- Raw `HttpRouter` routes remain version-neutral when an external protocol requires redirects, signatures, streaming, or a provider-owned response shape.
- No new endpoint is added to v1 unless it is required to complete a safe migration of an existing v1 group.

## What can leave v1 first

`apiKeys`, `ingestKeys`, `ingestAttributeMappings`, `recommendationIssues`, `scrapeTargets`, `investigations`, `anomalies`, `dashboards`, `observability`, and `onboarding` have passed the gate and are **removed**, as are the ten PlanetScale operations in `integrations`. Their `HttpApiGroup`s and `apps/api/src/routes/v1/*.http.ts` handlers are deleted; the matching `packages/domain/src/http/*.ts` files remain as schema-and-error modules because the v2 contracts and the backing services import their domain types. (`observability` is the exception: nothing outside its own two files referenced it, so the domain module went too.)

Two of those carry notes worth keeping:

- **PlanetScale** was removed against gate condition 3, deliberately. Telemetry for 2026-07-15 → 2026-08-14 showed exactly one call — `GET /api/integrations/planetscale/status` on 2026-08-05 — so the surface was not at zero. `/v2/integrations/planetscale` had been live and the v1 operations OpenAPI-deprecated for long enough that accepting one broken caller beat carrying the group. The OAuth callback and the webhook receiver stay: PlanetScale stores those URLs on its side.
- **`onboarding`** leaves `OnboardingService` with no consumer at all, because the v1 route was its only one. The service and `org_onboarding_state` are still in the tree, but the table is now written by nobody while `SetupAuditService` still reads it — so setup-audit's onboarding signals go stale from here on. Decide whether setup-audit stops reading it or onboarding persistence comes back; do not leave it as an unstated third state.

`sessionReplays` is **blocked, not close**. The gate's condition 1 is satisfied for the operations, but v2 is not a superset of v1 at the field level: `V2SessionReplay` and `V2SessionReplayListItem` omit the RUM analytics dimensions that v1's `GetReplayResponse` carries — `visitorId`, `visitorIsNew`, `referrer`, `referrerHost`, `utmSource/Medium/Campaign/Term/Content`, `entryPath`, `exitPath` — plus the list's `visitorId`, `utmSource`, `entryPath`, and `recorded`. The web detail page's Session rail and the list's visitor-linking column render these today, so migrating the callers as-is would silently gut cross-subdomain visitor linking and acquisition attribution. Extend the v2 resource first; that is a public-contract design decision, not a client rewrite.

| v1 group         | lift to v2                                                                                                                                                                                                                        | do not lift                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `sessionReplays` | Use the implemented v2 search, retrieve, events, transcript, manifest, and trace lookup operations — once they expose the analytics dimensions above. Promote a facet only if customers or agents need it as a stable capability. | Dashboard-only facet exploration and trace-summary helpers start in RPC. |

## Complete the public v2 resources

These v1 groups mix public resource operations with private orchestration. Split them before migration; copying the group wholesale would freeze internal implementation details into the public API.

| v1 group                                   | promote to v2                                                                                                                                                                                | move to internal RPC                                                                                                                                                                                                                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `errors`                                   | Issue events, comments, state transitions, assignee, and severity under `/v2/error_issues/{id}/...`.                                                                                         | Agent registration, claim, heartbeat, release, escalation-policy evaluation, and other worker coordination.                                                                                                                                                                                                        |
| `organizations` + `orgClickHouseSettings`  | Organization update/delete and customer-managed ClickHouse configuration as organization subresources, with explicit admin scopes.                                                           | Setup wizards or UI-only probes that merely coordinate several public operations.                                                                                                                                                                                                                                  |
| `integrations`                             | Promote a provider only when a public resource or supported external automation needs it. Slack and PlanetScale already meet that bar.                                                       | Cloudflare, GitHub, and Hazel dashboard control surfaces remain private until public demand exists. Split providers into independent contracts so one provider does not block retirement of another.                                                                                                               |
| `warehouse` (**removed**), `observability` | Keep the existing stable telemetry resources: traces, logs, metrics, services, and service map. Add a specific public resource endpoint only after its request and response shape is stable. | Raw SQL, generic query documents, arbitrary warehouse execution, attribute/facet discovery used only by dashboard builders, infrastructure drill-down helpers, and provider-specific chart queries. (`queryEngine` is **done** — the whole group moved to `/internal/query-engine`, so nothing was left to split.) |

### v2 telemetry gaps blocking full CLI parity

Rebuilding the CLI's remote mode on v2 surfaced capabilities local mode has and the public API does not. Each of these makes a command local-only today (`docs/local-mode.md` lists the user-facing effect):

- **No attribute discovery.** Nothing in `/v2` returns the attribute keys or values observed in telemetry; `/v2/attribute_mappings` is mapping configuration. This blocks `maple attributes` entirely and is the largest gap.
- **`/v2/traces/search` cannot sort.** It filters by `min_duration_ms` but has no order parameter, so "slowest N traces" is unexpressible.
- **No span-level search.** Search returns root-based `V2TraceSummary`; there is no way to list spans matching a name, and its `span_name` filter matches exactly where the CLI matches a substring.
- **Breakdown returns one aggregation per request.** A combined ranking (count + latency + error rate) needs N calls and cannot be ordered server-side by a composite.
- ~~**No fingerprint → issue lookup.**~~ Closed: `/v2/error_issues` takes a `fingerprint_hash` filter, and the CLI's `maple error <fp>` runs on it remotely.
- **No exception-type aggregate.** `/v2/error_issues` holds one triage object per fingerprint — it covers only fingerprints a sweep has turned into issues, and cannot say how many services an error spans, which `maple errors` prints.
- **No window comparison.** Nothing corresponds to `service_overview_compare`.
- **Offset pagination.** v2 lists seek by opaque cursor and cap at 100 rows, so `--offset` cannot be honoured.

There must never be a generic `/v2/query`, `/v2/sql`, or public query-builder execution endpoint. Those contracts expose Maple's storage and dashboard implementation rather than a durable product resource.

## Remove from the public-API plan

The following v1 groups are dashboard workflows or protocol surfaces. Do not port them to v2.

| v1 group                | destination                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `billing`               | **Done** — `/internal/billing`. `billingPublic` (`listPlans`) stayed on `MapleApi` at `/api/billing/plans`: it is served unauthenticated so a Clerk token-settle gap renders prices instead of a 401, which session-only authorization would defeat. Provider webhooks remain raw signed receivers.                                                      |
| `onboarding`            | Removed outright rather than moved — nothing called it. See the note above.                                                                                                                                                                                                                                                                              |
| `demo`                  | **Done** — `/internal/demo`.                                                                                                                                                                                                                                                                                                                             |
| `chat`                  | **Done** — `/internal/chat`. The `apply` mutation moved; the four raw chat-session streaming routes stayed where they were. They are a separate top-level `HttpRouter`, not a `MapleApi` group, and they resolve tenancy through `resolveHttpMcpTenant` (which accepts API keys) rather than the HttpApi middleware — so the split cost nothing to make. |
| `digest`                | **Done** — `/internal/digest`. Revisit if a public notification-subscription resource is ever designed.                                                                                                                                                                                                                                                  |
| `aiTriage`              | **Done** — `/internal/ai-triage`.                                                                                                                                                                                                                                                                                                                        |
| `auth` and `authPublic` | Keep standards-driven CLI/MCP/OAuth/JWT exchange routes version-neutral; they are authentication protocols, not v2 resources.                                                                                                                                                                                                                            |

## The one unauthenticated v2 group

`sharePublic` (`POST /v2/share/resolve`, `POST /v2/share/widget-data`) is on `MapleApiV2` **without** `AuthorizationV2` — the only group there that is. It is the viewer half of dashboard share links: the token in the request body is the credential, and the whole proposition is that the link resolves for someone with no Maple account, so requiring a bearer would mean it only worked for people who did not need it. Share _management_ (`/v2/dashboards/{id}/share`, and the widget-scoped twins) is ordinary authenticated v2 surface and carries the `dashboards` scope family.

Three consequences, all deliberate:

- **No scope.** `requiredScopeForRoute` would derive the family `share` from the path, but it is only called by `ApiAuthorizationV2Layer`, which these routes never run. There is no `share:read` scope and nothing issues one.
- **`security: []` and no `401`** in the OpenAPI spec. `openapi.test.ts` exempts the two operations by operationId through `PUBLIC_OPERATION_IDS` — an allowlist, so a third public operation cannot appear without someone editing it. Every other operation guarantee still applies to them.
- **The v2 rate limiter never runs.** These routes carry their own per-token and per-IP limiter in the handler; it is the only one on the path, not a supplement.

Prefer this shape over a new unauthenticated group. If a future surface needs anonymous access, weigh `/api/…` (as `billingPublic` did) first — the exemption above is narrow on purpose.

Moving a group to `/internal` swaps `Authorization` for `SessionAuthorization`, which refuses API-key-shaped bearers. That is the intended narrowing, and telemetry showed no API-key traffic to any of these paths — but it means the move is a breaking change for any API-key caller, not a transparent reroute.

The frontend halves of that move are easy to get wrong in ways nothing type-checks:

- `apps/web/src/lib/services/common/api-client-transform.ts` scopes the billing 401-retry by URL. It now matches **both** `/internal/billing/` and `/api/billing/`, because the authenticated operations and the public plan catalog ended up on different prefixes. Dropping either reinstates the hard 401 that the retry exists to prevent.
- `MapleInternalAtomClient` gained `retainedInternalQuery`, the `/internal` twin of `retainedQuery`, so the migrated settings panels keep unmount-surviving retention instead of flashing a skeleton on every visit. Its cache identity is prefixed `internal:` so a group name present on both clients cannot share a retention slot. Warehouse reads still go through `runWarehouseQuery` and must **not** be wrapped in it as well.

The following raw routes are intentional end-state routes, not v1 debt:

- OAuth callbacks that return redirects or RFC-defined OAuth errors.
- Webhook receivers whose signatures, retry status, and body are defined by the provider.
- Internal scraper or worker routes protected by service credentials.
- Streaming endpoints that cannot use the regular JSON request/response contract.

They still use typed internal failures and sanitized logging, but they keep their protocol-specific wire response instead of the v1 or v2 JSON envelope.

## Retirement gate

A v1 operation is deleted only when all five conditions pass:

1. Repository search shows no production caller, including web, CLI, MCP, workers, examples, and tests that model a real client.
2. The v1 OpenAPI operation is marked deprecated and points to its v2 or RPC replacement. Public callers receive `Deprecation`, `Sunset`, and migration-link headers for the announced window.
3. Per-operation access telemetry shows zero legitimate calls for 30 consecutive days in every deployed stage. Provider callbacks, health probes, and scanners are classified separately.
4. Published SDK, Terraform/IaC, docs, and customer examples no longer generate the v1 call.
5. Contract, handler, route-graph registration, error types used only by that operation, and tests are deleted in the same change.

If external traffic prevents removal, keep the compatibility adapter thin over the same service as v2. Do not add features or fork business logic in v1.

## Execution order

1. **Boundary consistency (this change):** apply API-wide v1 request-validation and defect middleware; apply the same v2 middleware once at `MapleApiV2`; distinguish request-decode failures from server-side response drift; define one exhaustive public policy map per domain error union and preserve every typed error's semantic tag through the v2 envelope.
2. **Deprecate complete duplicates:** done for `apiKeys`, `ingestKeys`, `ingestAttributeMappings`, `recommendationIssues`, `scrapeTargets`, and `investigations` — per-operation telemetry showed no production caller (the only August 2026 requests were manual `curl` probes), so the groups were deleted outright rather than deprecated. The PlanetScale v1 operations followed in the 2026-08-14 sweep, against the gate — see the note above.
3. **Finish near-complete resources:** done for dashboards and anomalies, both now deleted. Session replays is blocked on the v2 field gap described above.
4. **Build the internal tier:** done for `queryEngine`, which now serves from `MapleInternalApi` at `/internal/query-engine` behind `SessionAuthorization` — telemetry showed one API-key call across all 62 endpoints in 30 days, so the group was moved wholesale rather than split. Billing, demo, digest, and AI triage followed on 2026-08-14. Chat apply followed on 2026-08-15. Still to move: error-agent coordination.

    The `warehouse` group (`POST /api/tinybird/query`) was **deleted** in the same change rather than moved. Its only caller was the CLI's remote mode, which had been broken since 6aed357503 renamed the payload field `pipe` → `pipeName` without updating `apps/cli/src/core/remote-executor.ts` — every remote command failed payload decode, and the executor's test stubbed `fetch` without asserting the body, so nothing caught it. Remote mode was rebuilt on the public v2 telemetry resources instead of repairing an endpoint that let clients name server-side pipe identifiers.

5. **Split mixed v1 groups:** separate `errors`, provider integrations, and query/warehouse operations so public promotions and private RPC moves can be retired independently.
6. **Delete by evidence:** remove each empty v1 group as soon as its retirement gate passes; do not wait for every v1 group to be ready.
