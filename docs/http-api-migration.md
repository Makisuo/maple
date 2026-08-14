# HTTP API migration and v1 retirement

Status: implementation plan, audited 2026-08-13.

This document decides where the remaining `/api/...` surface belongs and defines the gate for deleting it. The governing rule is consumer intent, not transport convenience:

- `/v2` is the stable public resource API for customers, agents, IaC, and the dashboard.
- `/internal` is the private dashboard transport for product workflows that can change with the UI. It is a separate `HttpApi` (`MapleInternalApi`), session-only via `SessionAuthorization`, and absent from `/docs`. It is deliberately NOT a distinct wire protocol: the boundary is who may call it, not how. Earlier drafts of this document called this tier `/rpc`; the name changed when it shipped, the intent did not.
- Raw `HttpRouter` routes remain version-neutral when an external protocol requires redirects, signatures, streaming, or a provider-owned response shape.
- No new endpoint is added to v1 unless it is required to complete a safe migration of an existing v1 group.

## What can leave v1 first

These groups already have a v2 replacement used by the repository. Mark the v1 operations deprecated now, stop feature work on them, and remove each group after the retirement gate below passes.

| v1 group or provider                     | v2 replacement                 | action                                                                                                                                                     |
| ---------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PlanetScale operations in `integrations` | `/v2/integrations/planetscale` | Already deprecated. Split provider operations out of the monolithic v1 group so they can be deleted independently. Keep callback and webhook router paths. |

`apiKeys`, `ingestKeys`, `ingestAttributeMappings`, `recommendationIssues`, `scrapeTargets`, and `investigations` have passed the gate and are **removed**. Their `HttpApiGroup`s and `apps/api/src/routes/v1/*.http.ts` handlers are deleted; the matching `packages/domain/src/http/*.ts` files remain as schema-and-error modules because the v2 contracts and the backing services import their domain types.

`dashboards`, `anomalies`, and `sessionReplays` are close, but repository callers still use part of their v1 surface. Migrate those callers before starting the external-traffic clock:

| v1 group         | lift to v2                                                                                                                                                                      | do not lift                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `dashboards`     | Any remaining dashboard CRUD/import/history operation whose v2 equivalent already exists.                                                                                       | Nothing dashboard-specific belongs in RPC while it manipulates the public dashboard resource. |
| `anomalies`      | Move the dashboard's remaining resolve/link-issue/settings mutations to the implemented v2 operations.                                                                          | None of the current resource operations.                                                      |
| `sessionReplays` | Use the implemented v2 search, retrieve, events, transcript, manifest, and trace lookup operations. Promote a facet only if customers or agents need it as a stable capability. | Dashboard-only facet exploration and trace-summary helpers start in RPC.                      |

## Complete the public v2 resources

These v1 groups mix public resource operations with private orchestration. Split them before migration; copying the group wholesale would freeze internal implementation details into the public API.

| v1 group                                    | promote to v2                                                                                                                                                                                | move to internal RPC                                                                                                                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `errors`                                    | Issue events, comments, state transitions, assignee, and severity under `/v2/error_issues/{id}/...`.                                                                                         | Agent registration, claim, heartbeat, release, escalation-policy evaluation, and other worker coordination.                                                                                          |
| `organizations` + `orgClickHouseSettings`   | Organization update/delete and customer-managed ClickHouse configuration as organization subresources, with explicit admin scopes.                                                           | Setup wizards or UI-only probes that merely coordinate several public operations.                                                                                                                    |
| `integrations`                              | Promote a provider only when a public resource or supported external automation needs it. Slack and PlanetScale already meet that bar.                                                       | Cloudflare, GitHub, and Hazel dashboard control surfaces remain private until public demand exists. Split providers into independent contracts so one provider does not block retirement of another. |
| `warehouse`, `observability` | Keep the existing stable telemetry resources: traces, logs, metrics, services, and service map. Add a specific public resource endpoint only after its request and response shape is stable. | Raw SQL, generic query documents, arbitrary warehouse execution, attribute/facet discovery used only by dashboard builders, infrastructure drill-down helpers, and provider-specific chart queries. (`queryEngine` is **done** — the whole group moved to `/internal/query-engine`, so nothing was left to split.) |

There must never be a generic `/v2/query`, `/v2/sql`, or public query-builder execution endpoint. Those contracts expose Maple's storage and dashboard implementation rather than a durable product resource.

## Remove from the public-API plan

The following v1 groups are dashboard workflows or protocol surfaces. Do not port them to v2.

| v1 group                | destination                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `billing`               | Internal RPC for checkout, portal, attach/preview, and billing controls. Keep provider webhooks as raw signed receivers.      |
| `onboarding`            | Internal RPC.                                                                                                                 |
| `demo`                  | Internal RPC.                                                                                                                 |
| `chat`                  | Internal RPC for mutations; keep a raw streaming route if the transport requires it.                                          |
| `digest`                | Internal RPC until there is a separately designed public notification-subscription resource.                                  |
| `aiTriage`              | Internal RPC.                                                                                                                 |
| `auth` and `authPublic` | Keep standards-driven CLI/MCP/OAuth/JWT exchange routes version-neutral; they are authentication protocols, not v2 resources. |

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
2. **Deprecate complete duplicates:** done for `apiKeys`, `ingestKeys`, `ingestAttributeMappings`, `recommendationIssues`, `scrapeTargets`, and `investigations` — per-operation telemetry showed no production caller (the only August 2026 requests were manual `curl` probes), so the groups were deleted outright rather than deprecated. PlanetScale v1 operations still serve traffic and remain deprecated-not-removed.
3. **Finish near-complete resources:** move the remaining dashboard callers for dashboards, anomalies, and session replays to v2.
4. **Build the internal tier:** done for `queryEngine`, which now serves from `MapleInternalApi` at `/internal/query-engine` behind `SessionAuthorization` — telemetry showed one API-key call across all 62 endpoints in 30 days, so the group was moved wholesale rather than split. Still to move: billing, onboarding, demo, chat apply, digest, AI triage, the remaining warehouse helpers, and error-agent coordination. Preserve the billing-specific authentication retry behavior when its client moves.
5. **Split mixed v1 groups:** separate `errors`, provider integrations, and query/warehouse operations so public promotions and private RPC moves can be retired independently.
6. **Delete by evidence:** remove each empty v1 group as soon as its retirement gate passes; do not wait for every v1 group to be ready.
