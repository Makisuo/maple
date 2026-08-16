# Simplification audit — canonical report

> Provenance: whole-repo simplification audit run 2026-08-16 against clean HEAD
> `20a2722572`, coordinator plus bounded per-subsystem workers. The audit was
> read-only and kept its finding register in memory, so this file is the only
> durable copy — it was recovered from the session transcript, not written by
> the audit itself. Line references are anchored to that HEAD and drift as the
> code moves; re-verify before acting on one.
>
> Landed: `R-API01-01` (#490, `2fcb974a44`) and `R-WEB02-01` (#491, `baac3548c0`),
> both on 2026-08-16. Their register entries below are marked and kept rather
> than deleted — the evidence is what makes a later regression recognisable.
>
> Not reproduced: `R-WEB04-01`. The routes do lack `remountDeps`, but with the
> guard deliberately disabled, navigating widget A -> B in the running app still
> rendered B's own name, type, query and time range — the editor re-seeds from
> its `widget` prop. Its `critical` rating rests on a leak nobody has produced;
> needs a concrete reproducer before it earns a change.

Audit complete against clean HEAD `20a27225723faaf621e33a216e4e0ac598dfdf45`.

- 86 explicit subsystem boundaries reviewed.
- 70 subsystems have recommendations; 16 are explicit skips.
- 125 accepted recommendations.
- 11 dependency edges; graph is acyclic.
- 5 critical, 36 top, 50 next, 29 later, 5 deferred/gated.
- Every recommendation has evidence, proposed representation, implementation scope, risk, validation, confidence, impact, effort, and blast-radius data.
- No tests, builds, generators, mutations, commits, or pushes were performed by the audit.
- The audit introduced no repository changes. External work changed HEAD twice during inspection; every affected boundary was re-reviewed. Final `git status --short` is empty.

The former `R-WEB05-01` recommendation was removed because external commit `4f273670` implemented it. WEB-05 is now an explicit skip.

## Priority and implementation order

### Critical

| Finding | Why first | Confidence | Effort / blast |
|---|---|---:|---|
| `R-WEB04-01` | Route reuse can apply dashboard/widget-A editor state through widget-B IDs. | High | Low–medium / high |
| `R-LIB02-01` | Tenant scope can be marked safe while a joined source remains unconfined. | High | Medium–high / high |
| `R-API08-02` | Lease races and multi-write issue transitions can partially commit or clear a newer claimant. | High | Large / high |
| `R-API08-01` | Investigation start/settlement ownership is split and stale attempts can overwrite newer state. | High | Large / high |
| `R-PKG08-01` | ClickHouse compatibility, repairability, and readiness are conflated, allowing false success. | High | Medium–high / high |

### Best first implementation slices

1. ~~`R-API01-01` — terminal Postgres invocation scope.~~ Landed (#490).
2. ~~`R-WEB02-01` — generation-keyed authentication refresh.~~ Landed (#491).
3. `R-API04-02` — conditional API-key roll.
4. `R-OPS02-02` — dual-key deployment-environment projection.
5. `R-PKG10-01` — SDK-owned Cloudflare flush finalization.
6. `R-APP04-01`, then `R-APP04-02` — scraper outcome and result-buffer ownership.
7. `R-WEB04-01` — route-keyed dashboard/editor sessions.
8. `R-LIB02-01` — tenant-proof design and adversarial tests before migration.
9. `R-API08-02`, then `R-API08-01` as separately deployable lifecycle slices.
10. `R-PKG16-01`, then dependent `R-PKG09-01`.

### Remaining tiers

- Top: `R-API01-01`, `R-WEB02-01`, `R-API04-02`, `R-PKG10-01`, `R-OPS02-02`, `R-APP04-01`, `R-APP04-02`, `R-APP08-02`, `R-API11-01`, `R-API12-01`, `R-WEB10-01`, `R-WEB14-01`, `R-PKG02-02`, `R-PKG12-02`, `R-PKG16-02`, `R-APP07-02`, `R-API05-01`, `R-APP02-02`, `R-APP05-01`, `R-APP05-02`, `R-APP06-01`, `R-WEB01-02`, `R-WEB09-01`, `R-OPS02-01`, `R-OPS05-01`, `R-API02-02`, `R-API09-01`, `R-WEB06-02`, `R-WEB11-02`, `R-WEB12-02`, `R-WEB14-02`, `R-PKG03-01`, `R-PKG22-01`, `R-LIB04-02`, `R-LIB09-02`, `R-OPS15-01`.
- Next: `R-API02-01`, `R-API03-01`, `R-API07-01`, `R-API07-02`, `R-API11-02`, `R-API12-02`, `R-APP03-01`, `R-APP09-02`, `R-WEB01-01`, `R-WEB02-02`, `R-WEB03-02`, `R-WEB04-02`, `R-WEB06-01`, `R-WEB07-01`, `R-WEB09-02`, `R-WEB12-01`, `R-WEB13-01`, `R-PKG01-01`, `R-PKG02-01`, `R-PKG04-02`, `R-PKG05-01`, `R-PKG06-01`, `R-PKG06-02`, `R-PKG07-01`, `R-PKG07-02`, `R-PKG09-02`, `R-PKG12-01`, `R-PKG13-01`, `R-PKG17-01`, `R-PKG17-02`, `R-PKG18-01`, `R-PKG18-02`, `R-PKG19-01`, `R-PKG22-02`, `R-PKG23-01`, `R-LIB01-01`, `R-LIB02-02`, `R-LIB03-01`, `R-LIB04-01`, `R-LIB09-01`, `R-OPS01-01`, `R-OPS03-01`, `R-OPS03-02`, `R-OPS04-01`, `R-OPS07-01`, `R-API10-01`, `R-API10-02`, `R-PKG16-01`, `R-PKG20-02`, `R-PKG21-01`.
- Later: `R-APP08-01`, `R-WEB03-01`, `R-WEB08-01`, `R-PKG04-01`, `R-PKG03-02`, `R-PKG13-02`, `R-PKG15-01`, `R-PKG15-02`, `R-WEB11-01`, `R-API05-02`, `R-API06-02`, `R-API09-02`, `R-APP02-01`, `R-APP03-02`, `R-APP06-02`, `R-APP07-01`, `R-APP09-01`, `R-PKG08-02`, `R-PKG10-02`, `R-PKG11-01`, `R-PKG19-02`, `R-PKG23-02`, `R-OPS01-02`, `R-OPS04-02`, `R-OPS09-01`, `R-PKG09-01`, `R-PKG20-01`, `R-PKG21-02`, `R-PKG24-01`.
- Deferred/gated: `R-API03-02`, `R-API04-01`, `R-PKG24-02`, `R-LIB05-01`, `R-LIB05-02`.

Exact prerequisite edges:

```text
R-API08-01  → R-API12-02
R-WEB02-02  → R-WEB06-01
R-PKG03-01  → R-PKG03-02
R-PKG04-01  → R-PKG03-02
R-PKG16-01  → R-PKG09-01
R-PKG13-01  → R-PKG13-02
R-PKG09-02  → R-PKG15-02
R-LIB01-01  → R-PKG17-02
R-PKG09-02  → R-PKG18-01
R-PKG20-01  → R-PKG24-01
R-LIB05-01  → R-LIB05-02
```

## Coverage contract

“Tests” means every `*.test.*`, `*.spec.*`, `__tests__/**`, `test/**`, and `tests/**` path inside the stated boundary unless narrower paths are named.

### Deployable applications

- `API-01` — API worker composition/platform lifecycle — `apps/api/src/{index.ts,worker.ts}`, `{platform,http,runtime,observability,testing,lib}/**`, and API package/tool configs. Key: `worker.ts`, `pg-connection-scope.ts`, `DatabasePgLive.ts`. Interfaces: Worker fetch/queue/scheduled entrypoints and Layer graph. Status: recommend.
- `API-02` — HTTP/RPC route adapters — `apps/api/src/routes/**`, `internal-rpc.ts`, `internal-rpc.test.ts`. Domain HTTP contracts to service layers. Status: recommend.
- `API-03` — identity, authorization, OAuth, tenant context — `apps/api/src/services/auth/**`. Key: `AuthService`, `OAuthStateRepository`, `McpOAuthService`, tenant context. Status: recommend.
- `API-04` — organization, ingest keys, onboarding, billing — `apps/api/src/services/{org,billing}/**`, `autumn.config.ts`, `@useautumn-sdk.d.ts`. Status: recommend.
- `API-05` — warehouse execution/caching adapter — `apps/api/src/services/warehouse/**`. Interfaces: `WarehouseQueryService` and `QueryEngineService`. Status: recommend.
- `API-06` — dashboards/templates/sharing — `apps/api/src/services/dashboards/**`, `apps/api/src/dashboard-templates/**`. Status: recommend.
- `API-07` — alerting/anomaly/digest runtime — `apps/api/src/services/{alerts,digest}/**`, `apps/api/src/alerting.ts`. Status: recommend.
- `API-08` — errors/issues/investigations/AI triage — `apps/api/src/services/errors/**`. Status: recommend.
- `API-09` — integrations and asynchronous integration runtimes — `apps/api/src/services/integrations/**`, `planetscale-webhook-runtime*`, `queue-dispatch*`, `slack-reconcile-runtime*`, `vcs-sync-runtime*`. Status: recommend.
- `API-10` — MCP server/resources/prompts/tools — `apps/api/src/mcp/**`. Key includes `tools/registry.ts`, `tools/query-data.ts`, `lib/dashboard-schema-doc.ts`; the schema-derived docs feed `describe_dashboard_schema` and skill generation. Status: recommend.
- `API-11` — chat sessions and agent loop — `apps/api/src/chat/**`. Status: recommend.
- `API-12` — investigation and schema-apply workflows — `apps/api/src/workflows/**`. Status: recommend.
- `APP-01` — alerting worker — `apps/alerting/**` excluding deployment files owned by OPS-02. Worker schedule facade and tests. Status: skip.
- `APP-02` — Electric sync authorization proxy — `apps/electric-sync/**` excluding deployment files. Worker endpoint, registry, Electric client and tests. Status: recommend.
- `APP-03` — Rust ingest gateway — `apps/ingest/src/**` excluding generated insert mappings and load harness; Cargo/package configs included. Status: recommend.
- `APP-04` — Prometheus scraper — `apps/scraper/**` minus `Dockerfile` and `railway.json`. Status: recommend.
- `APP-05` — Slack agent — `apps/slack-agent/agent/**`, package/config/patch files, excluding deployment files. Status: recommend.
- `APP-06` — local observability UI — `apps/local-ui/**` excluding deployment files. Status: recommend.
- `APP-07` — CLI remote commands/control plane — CLI entry/core/remote command roots, selected control-plane tests and CLI configs; excludes local server/archive/warehouse files owned by APP-08. Status: recommend.
- `APP-08` — CLI local server/chDB/archive — `apps/cli/src/server/**` excluding generated UI embed, local server/archive command files, `core/warehouse.ts`, remaining CLI tests. Status: recommend.
- `APP-09` — marketing/docs/content site — `apps/landing/**` minus deployment files. Status: recommend.
- `APP-10` — mobile placeholder — `apps/mobile/**`. No manifest or executable caller. Status: skip.

### Web application

- `WEB-01` — shell/account/onboarding/settings/integration UI — listed component roots and top-level account/auth/settings routes. Status: recommend.
- `WEB-02` — data adapters/non-React domain utilities — `apps/web/src/api/**`, `apps/web/src/lib/**` excluding feature-specific lib roots. Status: recommend.
- `WEB-03` — shared atoms/hooks — `apps/web/src/atoms/**`, `apps/web/src/hooks/**`. Status: recommend.
- `WEB-04` — dashboards/widget builder/sharing — dashboard-builder/share components, dashboard/share routes, dashboard-control libraries. Status: recommend.
- `WEB-05` — query builder/analytics/performance UI — analytics/performance/query-builder components and routes, query-builder/raw-SQL libraries. Status: skip after the externally landed panel/source-state simplification.
- `WEB-06` — trace/service operation explorer — trace components/routes/library. Status: recommend.
- `WEB-07` — logs/metrics explorers — log/metric components/routes and log route tests. Status: recommend.
- `WEB-08` — replay explorer/player — replay components/routes. Status: recommend.
- `WEB-09` — alerting UI — alert components/routes/library. Status: recommend.
- `WEB-10` — errors/anomalies/investigations/recommendations UI — corresponding component and route roots. Status: recommend.
- `WEB-11` — infrastructure/service catalog/service map — infra/service-map/services components and routes. Status: recommend.
- `WEB-12` — chat/MCP/AI rendering — `ai-elements`, `chat`, `mcp` components and chat/MCP routes. Status: recommend.
- `WEB-13` — shared presentation — attributes/common/filters/icons/time-range/UI components and root error/boot files. Status: recommend.
- `WEB-14` — host bridge/router/labs/OG/tooling — explicit entrypoints, lab/OG/routes, configs/public/scripts; excludes generated route tree, deployment, and performance harnesses. Status: recommend.

### Shared Maple packages

- `PKG-01` — `packages/alchemy-maple/**`. Published provider resources/tests. Status: recommend.
- `PKG-02` — `packages/auth/**`. Shared auth package/tests. Status: recommend.
- `PKG-03` — `packages/browser/**`. Published browser SDK/tests. Status: recommend.
- `PKG-04` — `packages/browser-session/**`. Session capture/transport/replay core/tests. Status: recommend.
- `PKG-05` — `packages/clickhouse-cli/**`. ClickHouse library/CLI/tests. Status: recommend.
- `PKG-06` — `packages/db/**`. Drizzle schema, migrations, clients, scripts, tests. Status: recommend.
- `PKG-07` — `packages/domain/src/http/**`, `internal-rpc.ts`. Shared HTTP/RPC contracts. Status: recommend.
- `PKG-08` — `packages/domain/src/{clickhouse,tinybird}/**`. Warehouse schema/migrations/Tinybird ownership. Status: recommend.
- `PKG-09` — root `packages/domain/src/*.ts` excluding internal RPC and generated output; package configs. Status: recommend.
- `PKG-10` — `packages/effect-sdk/**`. Published telemetry SDK/tests. Status: recommend.
- `PKG-11` — `packages/email/**` excluding generated output. Status: recommend.
- `PKG-12` — `packages/infra/**`. Stage/URL/deployment policy helpers/tests. Status: recommend.
- `PKG-13` — `packages/otel-collector-maple-exporter/**`. Collector exporter and Go tests. Status: recommend.
- `PKG-14` — `packages/primitives/**`. Flat shared schema primitives. Status: skip.
- `PKG-15` — query-engine `src/ch/**`, SQL catalogue and baselines. Status: recommend.
- `PKG-16` — query-engine runtime/query-set/registry/dashboard-variable/query-builder roots plus remaining root sources/configs. Status: recommend.
- `PKG-17` — query-engine execution/profiles/caching. Status: recommend.
- `PKG-18` — query-engine observability/drain. Status: recommend.
- `PKG-19` — `packages/query-engine-integrations/**`. Status: recommend.
- `PKG-20` — `packages/query-model/**`. Status: recommend.
- `PKG-21` — UI chart roots and chart primitives. Status: recommend.
- `PKG-22` — UI trace visualization roots. Status: recommend.
- `PKG-23` — remaining `packages/ui/src/**` excluding chart/trace roots. Status: recommend.
- `PKG-24` — `packages/widgets/**`. Widget/dashboard document model. Status: recommend.
- `PKG-25` — UI package/TypeScript/Vitest/shadcn configuration files. Status: skip.

### Extractable libraries

- `LIB-01` — `lib/cache/**`. Status: recommend.
- `LIB-02` — `lib/clickhouse-builder/**`. Status: recommend.
- `LIB-03` — `lib/effect-cloudflare/**`. Status: recommend.
- `LIB-04` — `lib/effect-db/**`. Status: recommend.
- `LIB-05` — `lib/effect-router/**`. Status: recommend.
- `LIB-06` — `lib/llm/**`, vendored LLM core. Status: skip.
- `LIB-07` — `lib/otel-helpers/**`. Status: skip.
- `LIB-08` — `lib/thinking-orbs/**`. Status: skip.
- `LIB-09` — `lib/unitflow/**`. Status: recommend.

### Generated contracts, infrastructure, tooling, docs, examples

- `OPS-01` — generated route tree, CLI UI embed, domain/email generated outputs, Rust insert mappings and maintained generators. Status: recommend.
- `OPS-02` — Alchemy/Cloudflare/Docker/Helm/Collector/deployment assets and deployment scripts. Status: recommend.
- `OPS-03` — CI/release/root toolchain/config/scripts, excluding explicitly assigned generation/deploy/benchmark/probe/vendor-plugin files. Status: recommend.
- `OPS-04` — API integration/eval scripts and tests, web performance harnesses, ingest benchmarks/load test, cross-cutting benchmark scripts. Newly added widget grader/tasks were explicitly reviewed. Status: recommend.
- `OPS-05` — `docs/**`. Status: recommend.
- `OPS-06` — static governance/context/editor/brand assets, including named root prose files. Status: skip.
- `OPS-07` — `skills/**`, including Maple audit/onboarding/dashboard-widget/OTel recipe skills. Status: recommend.
- `OPS-08` — `examples/alchemy-maple/**`. Status: skip.
- `OPS-09` — `examples/effect-todo/**`. Status: recommend.
- `OPS-10` — `.context/effect/**`. Status: skip.
- `OPS-11` — `.agents/skills/**`, `.factory/skills/**`, `skills-lock.json`. Status: skip.
- `OPS-12` — `.deepsec/**`. Status: skip.
- `OPS-13` — `scripts/oxlint-plugins/anti-slop/**`. Status: skip.
- `OPS-14` — root `app.json`. Status: skip.
- `OPS-15` — `packages/domain/scripts/gen-error-label-migration.ts` and its ownership edge to frozen migration 0003. Status: recommend.
- `OPS-16` — `scripts/{aws-probe.run.ts,mock-cloudflare-oauth.ts}`. Status: skip.

## Accepted finding register

Notation: `C/I/E` = confidence/impact/effort. Every validation item is proposed; none was executed during this audit.

### API

- `R-API01-01` — **LANDED #490.** Shipped as `Cold | Open(handle) | Closed` with the refusal as a tagged `PgConnectionScopeClosedError` cause and `error.type = SCOPE_CLOSED` on the span. Terminal Postgres invocation scope. Evidence: `apps/api/src/platform/pg-connection-scope.ts:111-130`; late-fiber contract at `fork-request-scoped.ts:3-15`. Cold and closed currently share `socket === undefined`, allowing reopening after finalization. Use `Cold | Open(handle) | Closed`; close transitions first and remains idempotent. Scope: scope implementation/tests only; preserve API. Risk: concurrent teardown and caller-owned clients. Validate close-before-run, run-after-close, double close and no second socket. C/I/E: high/high/small; blast: all request/cron/workflow DB scopes.

- `R-API02-01` — Validated route-owned OAuth callback origin. Evidence: `routes/v1/integrations.http.ts:78-105`, `routes/v2/integrations.http.ts:43-108`. V1 reflects client-controlled forwarding headers while V2 separately validates them. Introduce `TrustedCallbackOrigin`; only trusted values construct provider callbacks. Scope: shared route helper plus v1/v2 tests. Risk: custom domains/proxies. Validate all stage/local hosts and spoofed suffixes. C/I/E: high/high/medium; blast: OAuth starts.

- `R-API02-02` — Chat-apply correlation is all absent or all present. Evidence: `packages/domain/src/http/chat.ts:13-28`, `routes/internal/chat.http.ts:50-63`. Three independent optionals admit six invalid partial states that may mutate without settling a transcript. Use optional nested origin or tracked/untracked union; reject partial legacy inputs before execution. Scope: domain contract, route and web payload builder. Validate eight combinations and executor non-invocation. C/I/E: high/medium-high/small-medium.

- `R-API03-01` — Atomic provider-scoped OAuth-state consumption. Evidence: `OAuthStateRepository.ts:15-57`, `oauth/connection-helpers.ts:144-169`; provider callers repeat read/delete. Replace with one `DELETE … RETURNING` command yielding `Missing | Expired | Active`. Scope: repository, five provider services and tests. Risk: preserve expiry/error wording and avoid consuming another provider’s state. Validate concurrent consumes and cross-provider replay. C/I/E: high/high/medium.

- `R-API03-02` — Persist CLI and MCP authorization as lifecycle states. Evidence: `packages/db/src/schema/cli-device-authorizations.ts:4-26`, `mcp-oauth.ts:12-37`, `CliDeviceAuthService.ts:227-447`, `McpOAuthService.ts:503-718`. Nullable markers admit contradictory terminal states and partial credentials. Add protocol-specific status discriminators, unions and DB checks. Scope: two staged migrations/services; public unions unchanged. Risk: row audit/backfill and mixed-version deployment. Validate full transition/concurrency/constraint matrices. C/I/E: high/high/large; deferred.

- `R-API04-01` — Atomic schema-apply kickoff claim. Evidence: `OrgClickHouseSettingsService.ts:1277-1348`. Active-run check, queued row and workflow launch fail independently, leaving duplicate launches or permanent queued rows. Claim with conditional insert/update containing a pre-generated workflow ID; distinguish confirmed from ambiguous launch failure. Scope: service/tests, no migration. Validate concurrent calls, retryability and explicit ID propagation. C/I/E: high/high/medium; deferred pending Workflow duplicate-ID semantics.

- `R-API04-02` — Conditional API-key roll. Evidence: `ApiKeysService.ts:268-309,332-348`. Read-then-unconditional updates allow concurrent successors and revoke/roll races. In one transaction, conditionally revoke and return the source row; only the winner inserts a successor. Scope: service/tests. Validate roll-vs-roll and revoke-vs-roll barriers. C/I/E: high/high/small-medium.

- `R-API05-01` — Inject warehouse client factory per Layer. Evidence: `WarehouseQueryService.ts:236-240,450-454,508-514`; tests/evals mutate a module global. Capture an immutable factory during service construction. Scope: service, tests/eval runtime and composition root. Risk: preserve per-instance route/client cache. Validate two simultaneous layers with different factories. C/I/E: high/high/small-medium.

- `R-API05-02` — One canonical migrated-query execution/cache plan. Evidence: `QueryEngineService.ts:100-145,175-235`, `runtime/query-engine.ts:1355-1372,1957-1973`. Logs execution and cache identity independently resolve the same request. Export a narrow `Legacy | Canonical{definition,input,policy}` resolver for the two migrated log shapes. Scope: service/runtime/direct-runner helper. Risk: cache-key compatibility. Validate execution/cache parity and collision separation. C/I/E: medium/medium-high/medium.

- `R-API06-02` — Discriminate dashboard-template requirement/readiness. Evidence: `dashboard-templates/types.ts:42-86`, invariant tests `index.test.ts:134-183`. Separate kind, optional fields and prefix gate permit every combination tests reject. Use telemetry, metrics-gated and integration-gated variants with explicit `AnyMetric`. Flatten to existing metadata wire. Validate every template’s flattened snapshot. C/I/E: high/medium/medium.

- `R-API07-01` — Remove legacy alert-service forwarding facade. Evidence: `AlertsService.ts:284-366,3015-3033`; forwarding-only test `AlertsService.test.ts:370-405`. Thirteen methods merely re-export already-public narrow services. Retain only evaluator-owned operations. Scope: service, graph/test fixtures; routes already use narrow tags. Risk: unpublished external imports. Validate graphs/routes/worker typecheck. C/I/E: high/medium-high/medium.

- `R-API07-02` — Explicit scheduler item outcomes. Evidence: `AlertsService.ts:2578-3010`, `AnomalyDetectionService.ts:1170-1189,2069-2151`. Mutable failure refs and zero sentinels collapse not-claimed, disabled, failed and processed work. Return local unions and reduce once. Scope: two services/tests and possibly metric naming. Risk: dashboards relying on inflated counts. Validate conservation for every outcome. C/I/E: high/medium-high/medium.

- `R-API08-01` — One command-oriented investigation start/settlement owner. Evidence: `InvestigationService.ts:155-215,449-516,742-756`, `ai-triage-enqueue.ts:296-388`, `apply-diagnosis.ts:69-191`. Manual and automatic paths have drifted; stale attempts can overwrite newer resolutions. Make insertion private, expose semantic resolve, and share a fenced lifecycle kernel. Scope: three modules/tests; narrow status endpoint compatibly. Risk: dedup, quota and in-flight workflows. Validate identical receipts and attempt-fenced late writes. C/I/E: high/very-high/large.

- `R-API08-02` — Transactional issue lease and transition command. Evidence: `ErrorsService.ts:419-507,789-878`, `ErrorIssueWorkflowService.ts:347-500`, DB lease columns `schema/errors.ts:83-100`. Stale readers can clear renewed leases; transition side effects are non-atomic. Make workflow service sole owner, use `Unclaimed | Held`, CAS predicates and one DB transaction; notify after commit. Validate heartbeat/expiry/new-claimant and rollback fault cases. C/I/E: high/very-high/large.

- `R-API09-01` — Slack installation lifecycle union. Evidence: `SlackIntegrationService.ts:261-280,843-888`. Production constructs active, remotely disconnected or absent states, while the type admits contradictory nullable payloads. Use three variants and keep v2 adapter/wire unchanged. Validate all adapter branches, especially plain absent. C/I/E: high/medium-high/small-medium.

- `R-API09-02` — One VCS failure command. Evidence: `vcs-sync-runtime.ts:145-197`. Final rate-limited messages can be acknowledged as exhausted while carrying retry-delay telemetry. Compute `Exhaust | RetryNow | RetryAfter`, then derive telemetry and exactly one queue action. Validate the four decision cases. C/I/E: high/medium/small.

- `R-API10-01` — Canonical `query_data` request union. Evidence: `mcp/tools/query-data.ts:46-150,157-430`, formatter `format-query-result.ts:13-70`. Raw parameters, coerced query and output metadata can disagree, e.g. log counts labeled as p95 duration. Decode six source/kind branches and derive execution plus presentation decisions once. Scope: tool, formatter, registry root-object handling and tests. Validate valid defaults, illegal combinations and executed/structured parity. C/I/E: high/high/medium.

- `R-API10-02` — One compiled unique MCP registry entry per tool. Evidence: `mcp/tools/registry.ts:61-240`, `dispatcher.ts:10-28`, `llm-tools.ts:82-99`. Arrays permit duplicate names with first/last/all behavior depending on surface; schemas compile repeatedly. Use ordered `Map<string,RegisteredTool>` owning codec, handler and descriptor; reject duplicates and expose a handler-free projection for web. Validate ordering, uniqueness and cross-surface parity. C/I/E: high/medium-high/medium.

- `R-API11-01` — Completion tool as one named value. Evidence: `chat/loop/types.ts:34-71`, `turn.ts:163-189,544-728`, `turn-runner.ts:270-290`. Tool map and closing name can disagree; production investigation chat supplies `submit_diagnosis` without enabling structured close. Use optional `{name,tool}`. Scope: loop/types/tool builder/runner and workflow caller. Validate normal, early and forced completion. C/I/E: high/high/small-medium.

- `R-API11-02` — One retry planner for thrown and provider-event failures. Evidence: `turn.ts:298-481`; classification already exists in `retry.ts:23-48`. Two paths duplicate pruning, attempt accounting, budget, markers, sleeps and recursion. Normalize to descriptors and execute one `Retry | Finish` plan. Validate parity across both failure representations. C/I/E: high/medium-high/medium.

- `R-API12-01` — Postgres is the sole hypothesis-lane outcome. Evidence: `InvestigationFanoutWorkflow.run.ts:263-271,800-942,1068-1089`. In-memory step results duplicate durable rows and retry exhaustion can leave a row nonterminal even though memory says no-finding. Return acknowledgements and run one idempotent reconciliation step before validation. Validate callback/step failure positions. C/I/E: high/high/small-medium.

- `R-API12-02` — Normalize validator output into `Promoted | Inconclusive`. Evidence: `validator-agent.ts:137-161`, workflow `:408-416,1098-1129,1258-1301`. Nullable ID/report pairs are repaired repeatedly; unknown IDs can still yield a ranked diagnosis with no promoted lane. Normalize once against candidate IDs. Scope: validator/workflow/tests; version cached step if needed. Validate missing/unknown promotion combinations. C/I/E: high/high/medium; depends on `R-API08-01`.

### Applications

- `R-APP02-01` — Electric availability as one configured capability. Evidence: `config.ts:17-21`, `ElectricClient.ts:140-239`, `shape.http.ts:55-71`. URL/credentials/result/gate admit contradictory clients and duplicate not-configured handling. Use `Disabled | Configured(SelfHosted | Cloud)` and acquire a configured client whose fetch cannot return NotConfigured. Preserve route error precedence. C/I/E: high/medium/small-medium.

- `R-APP02-02` — Server-owned prepared shape plan. Evidence: `shapes/registry.ts:148-197`, `shapes/request.ts:29-75`, `ElectricClient.ts:73-106`. Scope policy is resolved twice and a scoped shape can be paired with no/arbitrary binding. Let decoder construct an opaque resolved definition/binding plan; URL builder consumes it. Validate every registry entry and positional parameters. C/I/E: high/high/small-medium.

- `R-APP03-01` — Awaited Autumn usage owner. Evidence: `apps/ingest/src/autumn.rs:25-49,71-93,220-313`, `main.rs:1566-1572,1729-1754`. Detached worker/final flush can leave a promoted queued generation unsent and process exit does not await it. Return cloneable tracker plus main-owned shutdown/join; drain through bounded deadline before telemetry shutdown. Validate failed-final-flush plus newly queued generation. C/I/E: high/high/medium.

- `R-APP03-02` — Remove inert exporter-concurrency setting. Evidence: `main.rs:281-285`, `telemetry.rs:402-466,683-703`; exactly one worker exists per shard/destination. Delete parser/config/deployment passthrough and document actual topology. Risk: zero value stops causing startup rejection. Retain WAL/order tests. C/I/E: high/medium/small.

- `R-APP04-01` — Scrape outcome union. Evidence: `ScrapeScheduler.ts:54-78,243-423`; delivery-blocked is already logged as rate-limited. Use `Success` or `Failure{reason,message,retryAfter?}` and derive policy/telemetry/logs once. Scope: scheduler/tests. Validate 429/503, auth, ingest 402 and generic failures. C/I/E: high/high/small.

- `R-APP04-02` — Serialized pending-result buffer. Evidence: `ScrapeScheduler.ts:201-210,495-538`. Contents, capacity, order and gauge update separately; concurrent enqueue/requeue makes metrics inaccurate. Introduce local `ResultBuffer` with atomic enqueue/take/requeue/size transitions, network outside the lock. Validate blocked flush, overflow and interruption. C/I/E: high/high/small-medium.

- `R-APP05-01` — Unified Slack workspace resolve/cache/revocation state. Evidence: `agent/lib/maple.ts:71-122,145-158`. Revocation deletes only settled cache, so an earlier in-flight resolve can later recache revoked secrets. Use one team-state map with pending/resolved/negative/revoked identity and publish only if still current. Validate resolve→revoke→late-response race. C/I/E: high/high/small-medium.

- `R-APP05-02` — Explicit Slack thread load/drop outcomes. Evidence: `thread-context.ts:53-71`, `thread-follow-up.ts:440-461`, `channels/slack.ts:162-203`; pinned Eve swallows refresh failures and supports `null` drops. Normalize to `root | loaded | unavailable`; fail open on unavailable and return `null` for intentional disengagement. Validate production-faithful swallowed failure and no handler-failed path. C/I/E: high/high/small-medium.

- `R-APP06-01` — Metric identity is `{name,type}` end to end. Evidence: `use-local-metrics.ts:65-189`, `metrics-list-view.tsx:124-130`, `use-local-metric-detail.ts:9-34`. List preserves type but preview/routes/cache/detail collapse to name, merging same-name gauges and sums. Introduce canonical identity/key/route. Validate same-name different-type fixtures and legacy URL behavior. C/I/E: high/high/small-medium.

- `R-APP06-02` — One local connection/pulse state owner. Evidence: `use-local-ingest-pulse.ts:31-57`, `use-local-connection.ts:25-32`, `ingest-status.tsx:23-49`. A cached pulse plus refetch error can render disconnected main content and Receiving header. Return one discriminated connection state and pass it to header. Validate pending/idle/live/failure/cached-failure. C/I/E: high/medium/small.

- `R-APP07-01` — Parsed CLI invocation owns backend and format. Evidence: `cli.ts:17-45`, `core/mode.ts:23-86`, `lib/output.ts:12-16`. Raw argv is rescanned differently, so accepted inline format syntax can render incorrectly. Normalize parsed shared flags into backend override and output format context. Validate before/after subcommand and `--format=` forms. C/I/E: high/medium/medium.

- `R-APP07-02` — Use schema-decoded HTTP auth contract. Evidence: `commands/auth.ts:15-28,74-125,204-244`, domain auth contract `packages/domain/src/http/auth.ts:10-237`. Generic casts let unknown poll status fall through as completed. Use generated `HttpApiClient` or require an explicit success schema; switch exhaustively. Validate malformed completion cannot persist credentials. C/I/E: high/high/small-medium.

- `R-APP08-01` — Local-store migration cursor state machine. Evidence: `local-store-migration-module.ts:7-59`, `local-store-migrations.ts:84-105,429-610,1234-1327,1567-1579`. Phase, step statuses, index, payload and failure are redundant authorities; partial writes can persist contradictions. Introduce a discriminated cursor and explicit transitions with a strict v2 compatibility decoder. Validate every crash seam and legacy resumable state. C/I/E: high/high/large.

- `R-APP08-02` — One nullable chDB native handle. Evidence: `server/chdb.ts:281-328,351-432`. Owner and query pointers split open/closed state; post-close query can call freed memory and failed construction leaks the sole connection. Store `{ownerPointer,queryPointer}|null`, atomically take on close and cleanup every construction failure. Validate bootstrap-failure recovery and pre-FFI post-close rejection. C/I/E: high/high/small-medium.

- `R-APP09-01` — One ordered documentation navigation model. Evidence: `docs-nav.ts:1-20`, four Astro consumers and `DocsSearch.tsx:20-30`. Sidebar/search/category/prev-next own divergent group orders. Build one browser-safe descriptor/ranking model while keeping `astro:content` server-only. Validate omitted groups, unknown ordering and alignment. C/I/E: high/medium-high/medium.

- `R-APP09-02` — Registry-driven integration pages/discovery. Evidence: `lib/integrations.ts:12-21`, nine repeated route files, `RelatedIntegrations.astro:8-23`, `NavBar.tsx:117-121`. Route existence, copy, preview, nav and locale links drift; localized Next.js pages are English and related links lose locale. Use typed page specs/shared renderer and three locale dynamic routes. Validate all nine URLs, JSON-LD and locale links. C/I/E: high/high/medium.

### Web

- `R-WEB01-01` — Local editor-session models for settings forms. Evidence: `scrape-targets-section.tsx:174-344`, `attribute-mappings-section.tsx:89-186`. Dialog/edit/save/draft fields and scrape auth modes are independent. Use local create/edit session plus editing/saving phase and auth union; centralize conversion. Validate blank-secret edit and payload parity. C/I/E: high/medium-high/medium.

- `R-WEB01-02` — Query Result owns settings load/error state. Evidence: `notifications-section.tsx:27-91`, `escalation-policy-section.tsx:69-138`. Failures become valid-looking defaults or are hidden after local copying. Parent branches on Result and mounts a draft-owning child only from usable data; default only typed not-found. Validate background failure and unsaved draft preservation. C/I/E: high/high/medium.

- `R-WEB02-01` — **LANDED #491.** Shipped as `{generation, promise}`, plus a bounded re-resolve for a caller whose identity changed while it waited. Generation-keyed authentication refresh. Evidence: `auth-headers.ts:23-30,54-77,93-103`. Post-switch requests can join an old identity’s promise and send its token despite cache-generation checks. Store `{generation,promise}`, reuse/deliver/clear only if current. Validate org/provider/sign-out races. C/I/E: high/high/low.

- `R-WEB02-02` — Normalize legacy trace filters once. Evidence: `api/warehouse/traces.ts:50-94,150-217,288-336,504-557`. List/facet/stat paths redeclare common wire filters and cast between shapes. Create shared wire fragment and canonical plural normalization; keep list-only controls local. Validate parity for every scalar/plural alias and attribute mode. C/I/E: high/medium/medium.

- `R-WEB03-01` — Session-keyed chat state machine. Evidence: `use-maple-chat.ts:413-417,479-492,604-733`. History, transcript, phase, errors and POST/stream completions can cross session boundaries. Use a reducer keyed by session epoch; every async completion carries it; derive existing public fields. Validate old-session POST resolve/reject after switching. C/I/E: high/high/medium-high.

- `R-WEB03-02` — Query/generation-keyed pagination. Evidence: three infinite hooks and anomaly route `routes/anomalies/index.tsx:94-166`. Old pages/cursors can drive new queries and stale load-more can repopulate a refreshed tail. Use keyed reducer with generation-tagged replace/append commands and stale completion rejection. Validate filter changes, same-key refresh, tab changes and waiting-first-page gating. C/I/E: high/high/medium.

- `R-WEB04-01` — Route identity owns dashboard/editor sessions. Evidence: [dashboard route](apps/web/src/routes/dashboards/$dashboardId.tsx:65), [widget route](apps/web/src/routes/dashboards/$dashboardId_.widgets.$widgetId.tsx:35), provider seeds. TanStack reuses components across entity parameters, retaining preview/form/SQL/time-range state. Add entity-only `remountDeps` and coherent local overlay values. Validate A→B navigation with active preview/dirty form. C/I/E: high/critical/low-medium.

- `R-WEB04-02` — Canonical decoded section-view state. Evidence: `section-view-state.ts:16-172`, dashboard route `:159-190`, preview/read-only consumers. Four URL strings admit collapsed+expanded contradictions and repeated parsing. Decode once to maps, update in memory, encode only at route boundary. Validate legacy expanded-wins decode and canonical output. C/I/E: high/high/medium.

- `R-WEB06-01` — One effective trace-filter route state. Evidence: `routes/traces/index.tsx:34-184`, `advanced-filter-sync.ts:16-365`, sidebar `:42-170`. Raw clause and decomposed fields diverge; clear omits namespaces. Make typed decomposed state authoritative and treat text as draft/bookmark input. Validate every filter’s active/clear/serialization behavior. C/I/E: high/high/medium; depends on `R-WEB02-02`.

- `R-WEB06-02` — Selected span identity defines detail-session lifetime. Evidence: trace route `:222-235,357-387`, `span-detail-panel.tsx:127-140,371-501`. Uncontrolled tabs/log sheets survive span changes. Key stateful subtree by `(traceId,spanId)` or use an explicit controlled capability union. Validate trace/infrastructure/log changes on desktop and mobile. C/I/E: high/medium-high/low.

- `R-WEB07-01` — Displayed-log identity defines detail-session lifetime. Evidence: `log-detail-sheet.tsx:31-112`, `log-hero-header.tsx:37-52`, existing `lib/log-key.ts`. Different descendants reset differently, leaving stale tab/expansion/log state. Key content under a local session by the canonical composite identity. Validate timeline selection and trace-to-non-trace fallback. C/I/E: high/medium-high/medium.

- `R-WEB08-01` — Generation-scoped replay-loader state machine. Evidence: `use-replay-chunk-loader.ts:100-310`, `replay-player-context.tsx:541-548`. Loaded ranges, queue, seed and seek target transition separately; consumed targets can remain live. Use waiting/seeding/ready reducer with generation/range-tagged events and one-shot seed resume. Validate seek, stale completion and recovery/remount. C/I/E: high/high/medium-high.

- `R-WEB09-01` — Alert-rule initialization union. Evidence: `alert-create-page-content.tsx:35-48,169-201`; terminal list failure currently renders a permanent skeleton. Return `loading | failed | ready`, with draft only in ready. Validate edit success/missing/failure and stable remount keys. C/I/E: high/high/low-medium.

- `R-WEB09-02` — Pending destination commands keyed by destination ID. Evidence: `settings-tab.tsx:43-78,117-177,269-279`, `destination-card.tsx:112-150`. Global testing/deleting IDs and unowned toggles race across cards. Use `Map<DestinationId,Action>` and exact-entry cleanup in `finally`. Validate out-of-order A/B and same-ID suppression. C/I/E: high/medium-high/medium.

- `R-WEB10-01` — Derive issue actions from canonical transition matrix. Evidence: `packages/domain/src/http/errors.ts:37-63`, `state-select.tsx:34-49`, context/bulk menus. Two menus expose impossible transitions and bulk selection discards state. Carry `{id,state}` and compute allowed intersection from `WORKFLOW_TRANSITIONS`. Validate terminal and mixed selections. C/I/E: high/high/low-medium.

- `R-WEB11-01` — Genuine node/edge discriminants in service map. Evidence: `service-map-utils.ts:63-164,480-520`, node/view selection paths. Optional kind-specific payloads and fake zero traffic for structural edges force casts, scans and ID parsing. Use node and traffic-vs-structural unions plus one node index. Validate detail selection/declutter/ELK. C/I/E: high/high/high.

- `R-WEB11-02` — Preserve normalized edge types through row lowering. Evidence: warehouse adapters define exact shapes, but `service-dependencies-tab.tsx:24-188` casts them to an all-optional 15-field shadow. Delete `RawEdge`; use three typed lowering functions and shared required metrics projection. Validate service/database/HTTP/messaging/RPC fixtures. C/I/E: high/medium-high/low.

- `R-WEB12-01` — Chat page and subject unions. Evidence: `routes/chat.tsx:14-52`, `chat-page.tsx:18-190`, `chat-conversation.tsx:48-244`, `context-preamble.ts:22-46`. Shared/investigation/widget/page/delivery fields admit contradictory combinations across four layers. Decode route to `shared | interactive(subject?)`, carry a discriminated subject/context. Validate deep links, seeding and tab identity. C/I/E: high/high/medium.

- `R-WEB12-02` — Decode inline LLM annotations at parser boundary. Evidence: `parse-annotations.ts:3-24`, renderer assumptions in `inline-trace.tsx`, `inline-error.tsx`, `inline-service.tsx`. JSON is cast directly to trusted payloads. Add per-tag Effect schemas and preserve invalid annotations as visible text. Validate every tag, malformed/wrong/null/mixed payloads. C/I/E: high/medium-high/low.

- `R-WEB13-01` — Relative-or-absolute time-range intent. Evidence: `time-range-picker/types.ts:3-13`, emitters and repeated dashboard conversions. Three optionals admit missing/partial/conflicting modes. Emit `{type:'relative',value}` or `{type:'absolute',startTime,endTime}` and make URL application exhaustive. Validate all picker sources and maximum-range behavior. C/I/E: high/medium-high/medium.

- `R-WEB14-01` — One router-auth snapshot owner. Evidence: `main.tsx:72-130,159-165`, `router.tsx:25-31`. Provider-specific effects/latches mishandle cleanup, causing identity changes to skip invalidation. Track one previous primitive snapshot, install context first, invalidate once on later changes. Validate Clerk/self-hosted/StrictMode sequences. C/I/E: high/high/low-medium.

- `R-WEB14-02` — Domain-schema decoding for OG network/cache data. Evidence: domain share schemas, `og/share-links.ts:17-24`, `share-preview.ts:90-93,188`. Worker-local casts trust mutable cache/network JSON and can bypass safe fallback. Decode metadata/card plus cache envelope and treat failure like transport failure. Validate malformed network/cache bodies. C/I/E: high/medium-high/low.

### Packages

- `R-PKG01-01` — Discriminated published alert-rule authoring props. Evidence: `AlertRule.ts:21-55`, server validation `AlertRuleModel.ts:645-698`. Flat optionals let invalid IaC compile. Intersect a signal union with a comparator union and preserve serialization/Alchemy inputs. Validate positive and `@ts-expect-error` fixtures. C/I/E: high/medium-high/medium.

- `R-PKG02-01` — Parse raw auth environment once. Evidence: `packages/auth/src/index.ts:200,231-339,464-480`; API/Electric repeat permissive unknown→self-hosted normalization. Decode to `ClerkConfig | SelfHostedConfig` with mode-owned required secrets. Scope includes host normalization. Validate unknown/blank/mixed modes and brands. C/I/E: high/high/medium.

- `R-PKG02-02` — Normalized verified self-hosted JWT claims. Evidence: `packages/auth/src/index.ts:32-53,121-198,301-410`. Permissive decoded claims require a second validation pipeline. After signature verification, decode `SelfHostedSessionClaims` with required brands, literal mode, normalized roles and HS256. Validate correctly signed malformed claims and temporal boundaries. C/I/E: high/high/low-medium.

- `R-PKG03-01` — One browser session lifecycle handle. Evidence: `packages/browser/src/init.ts:36-43,104-180`. Replay and metadata handles are mutually exclusive but stored separately. Use one optional `SessionLifecycleHandle` plus pending lazy settlement. Validate lazy failure fallback and exactly one shutdown. C/I/E: high/medium-high/low.

- `R-PKG03-02` — Shared browser SDK shutdown completion. Evidence: `init.ts:45-99,182-191`. `stopped`, global handle/config and cleanup completion can disagree; concurrent shutdown returns early and failure wedges singleton state. Use one active owner with memoized shutdown promise and guaranteed cleanup. Validate concurrent/failing teardown. C/I/E: high/high/low-medium; depends on `R-PKG03-01` and `R-PKG04-01`.

- `R-PKG04-01` — Real browser-session write barriers. Evidence: event/replay/lifecycle files detach uploads and metadata writes. Explicit flush/shutdown can resolve while older work remains. Add an internal pending-write barrier and await all registered work on explicit shutdown. Risk: stalled requests require deliberate timeout. Validate deferred threshold/heartbeat/rotation writes. C/I/E: high/high/medium-high.

- `R-PKG04-02` — Capture event context at emission. Evidence: `events-sink.ts:9-29,121-143,252-309`, bespoke workaround `track.ts:87-99`. Timestamp, URL and active trace are otherwise read during later flush. Normalize immediately to private captured event and make lowering pure. Validate context changes before flush. C/I/E: high/high/medium.

- `R-PKG05-01` — Import-safe ClickHouse package plus validated CLI invocation. Evidence: package root points to `cli.ts`, which runs/exits on import; parser at `cli.ts:60-105,216-253` ignores typos/missing values. Split pure index from guarded bin and parse a discriminated invocation. Validate import safety, help/version precedence and usage errors. C/I/E: high/high/medium.

- `R-PKG06-01` — Lexical cleanup before DB-script process exit. Evidence: `planetscale-connection.ts:22-25,80-131,205-225` and several script `finally` blocks. Shared `fail()` calls `process.exit`, bypassing credential/client cleanup. Throw structured failures in helpers and set exit code only at top level. Validate cleanup precedes failure. C/I/E: high/high/medium.

- `R-PKG06-02` — Durable batch backup sink for dashboard backfill. Evidence: `backfill-dashboard-datasource-v3.ts:18-40,183-215,316-350`. “Backed up” rows live in memory until the whole run completes. Append/flush/fsync each batch before its transaction; use exclusive restrictive file creation. Validate second-batch failure and fsync failure causing zero covered writes. C/I/E: high/medium-high/medium.

- `R-PKG07-01` — Three-state PlanetScale integration status. Evidence: domain contracts `integrations.ts:270-305`, v2 equivalent, API constructors and inconsistent web branching. Use literal-narrowed disconnected, pending-selection and bound variants while retaining existing wire fields. Validate contradictory rejection and bound-revoked case. C/I/E: high/high/medium.

- `R-PKG07-02` — Correlated v2 continuation model. Evidence: `v2/envelopes.ts:85-108,151-192`; 26 list schemas and permissive consumers. Model final `{has_more:false,next_cursor:null}` versus continuation `{true,string}` and derive both from one cursor. Migrate custom producers/web/Alchemy decoder. Validate malformed later pages fail without partial output. C/I/E: high/high/medium.

- `R-PKG08-01` — Authoritative ClickHouse reconciliation plan. Evidence: [diff.ts](packages/domain/src/clickhouse/diff.ts:118), service/workflow duplicated desired-schema and incompatible success logic. Use `ready{extras} | repairable{actions,extras} | blocked{blockers,safeActions,extras}` plus one desired-schema builder. Workflow re-introspects and stamps only ready. Validate extras-only readiness and blockers never succeeding. C/I/E: high/very-high/medium-high.

- `R-PKG08-02` — Feature decisions beside the schema-feature registry. Evidence: `clickhouse/features.ts:17-73`, CLI and API workflow implement three decision trees. Add a small pure `unsupported | already_applied | record_only | execute` helper. Keep orchestration local. Validate one shared decision matrix and adapter parity. C/I/E: medium/medium/medium.

- `R-PKG09-01` — Evaluation-ready alert-plan union. Evidence: `domain/query-engine.ts:596-615`, alert/runtime repeatedly validate nullable query/raw SQL/sample strategy. Use `spec{AlertTimeseriesQuery,...} | raw_sql{rawSql,...}` and derive sample-count behavior from source. Preserve legacy DB compatibility at persistence edge. Validate legacy decode and cache separation. C/I/E: high/high/medium-high; depends on `R-PKG16-01`.

- `R-PKG09-02` — Attribute-filter operator arity union. Evidence: `domain/query-engine.ts:41-48`, `traces-shared.ts:102-147`, runtime shadow shape. Missing operands silently become empty string, zero or false predicates. Use exists/no operand, in/values and scalar/value variants. Validate schema rejection and every CH predicate. C/I/E: high/high/medium.

- `R-PKG10-01` — Cloudflare flush owns deferred-finalizer drainage. Evidence: `effect-sdk/src/cloudflare/index.ts:164-187`; API/Electric duplicate `setTimeout(0)` workarounds. Yield one macrotask inside serialized SDK flush. Remove caller workarounds later. Validate next-macrotask span and overlapping flush. C/I/E: high/high/low.

- `R-PKG10-02` — One browser resource builder for both telemetry presets. Evidence: `client/layer.ts:81-103`, `client/flushable.ts:130-155`; only one emits stable instance ID. Share package-private builder with stable ID, dual environment keys and existing precedence. Validate equivalent resource invariants. C/I/E: high/medium/low.

- `R-PKG11-01` — Store weekly digest data volume once. Evidence: `weekly-digest-core.ts:34-52`, renderer paths and contradictory sample values. Move value/delta to one canonical ingestion property and render both sections from it. Scope: email sources/samples plus digest producer. Validate both displayed totals agree. C/I/E: high/medium/low.

- `R-PKG12-01` — One database deployment policy per stage. Evidence: `infra/src/cloudflare/stage.ts:126-239`, API/alerting Alchemy consumers. Mode/ref IDs/names/unused branch projections describe contradictory states. Return `none | managed{name} | ref{complete consumer IDs}` and delete unused branch projection. Validate exact stage table and no production renames. C/I/E: high/high/medium.

- `R-PKG12-02` — Reject partial EU topology. Evidence: `aws/stage.ts:3-88`, root/app ingest Alchemy wiring. “EU” changes only AWS resources while sharing stack, Cloudflare, DB and warehouse identity. Accept unset/US, reject EU until full instance identity exists. Validate US plan byte-equivalence and external deployment inventory. C/I/E: high/high/low-medium.

- `R-PKG13-01` — Collector-native retry disposition. Evidence: exporter factory enables retries while encoding/client errors are undifferentiated. Return structured HTTP errors and mark incontrovertibly permanent local/status failures with `consumererror.NewPermanent`; keep transport/408/429/5xx retryable. Validate disposition matrix and one-attempt permanent case. C/I/E: high/high/medium.

- `R-PKG13-02` — Partial-progress mixed-metric export. Evidence: `exporter_metrics.go:42-178`. Four table writes return only first error, so retry duplicates tables already committed. Lower to ordered typed commands and return `consumererror.NewMetrics` containing only failed/unattempted types. Validate failures at every command position. C/I/E: high/high/medium-high; depends on `R-PKG13-01`.

- `R-PKG15-01` — Source-grain-compatible rollup plan. Evidence: services/logs/metrics enforce divisibility but trace/service-map helpers use thresholds only; arbitrary v2 bucket widths reach them. Return discriminated raw/minute/hour/mixed plan through one compatibility predicate. Validate bucket/source matrix and SQL parity. C/I/E: high/high/medium-high.

- `R-PKG15-02` — Exhaustive named-pipe registry. Evidence: `pipe-dispatch.ts:75-156,202-835`; domain owns names but dispatch accepts strings/unknown records and tests omit builders. Use `Record<WarehouseQueryName, entry>` with explicit per-pipe decoders. Validate exhaustive coverage, coercion policy, baselines and DESCRIBE. C/I/E: high/high/high; depends on `R-PKG09-02`.

- `R-PKG16-01` — Authoritative group-by normalization. Evidence: `query-builder/model.ts:599-737,754-852`; documented/private dashboard aliases include snake case that exported alert resolver omits. Use one source-specific alias map/prefix handler; generate token catalogue from it; retain consumer policy. Validate catalogue/resolver/builder parity and alert compilation. C/I/E: high/high/medium.

- `R-PKG16-02` — Ordered per-query result plus diagnostic. Evidence: `query-set/window.ts:27-35,84-97,157-260`. Concurrent children mutate a completion-order diagnostics array and primary failure attempts are discarded. Each child returns `{result,diagnostic}`; unzip ordered `Effect.forEach` result. Validate delayed completion ordering and retained attempts. C/I/E: high/high/low-medium.

- `R-PKG17-01` — Capability planning and execution share one route. Evidence: `execution/executor.ts:289-455,739-1037`; API resolver can refresh between two resolutions. Carry request-local `{route,dialect,capabilities}` into first execution, discarding it only after auth invalidation. Validate one normal resolution, alternating resolver coherence and exactly two on auth retry. C/I/E: high/high/medium.

- `R-PKG17-02` — Schema-decode persisted bucket segments. Evidence: `caching/bucket-cache.ts:21-41,335-377,493-548`; weak guard accepts arrays/non-numeric series. Use local Effect Schema reusing domain `TimeseriesPoint`; decode failure is cache miss, relational geometry remains separate. Validate nested corruption and miss/recompute telemetry. C/I/E: high/medium-high/low-medium; depends on `R-LIB01-01`.

- `R-PKG18-01` — Trace-search scope/result discriminants. Evidence: `observability/types.ts:23-65`, `search-traces.ts:39-115`, MCP/CLI adapters. `spanName`/`rootOnly` combinations and nullable result fields conflate trace summaries and span matches. Use explicit trace-vs-span request/result unions. Validate all scopes and remote refusal. C/I/E: high/medium-high/medium; depends on `R-PKG09-02`.

- `R-PKG18-02` — Separate service facets from attribute discovery. Evidence: `observability/types.ts:222-229`, `explore-attributes.ts:22-101`, MCP branch ordering. Accepted `services+key` can query the wrong span-attribute pipe. Limit attributes to trace/metrics and expose typed service facets separately. Validate full routing matrix and reject before warehouse call. C/I/E: high/medium-high/medium.

- `R-PKG19-01` — Authoritative integration SQL catalogue. Evidence: `query-engine-integrations/src/catalog.ts:1-91`; public builders greatly outnumber seven covered names, and API analyzer ignores the catalogue. Each fixture owns builder, variant, parameters and real row schema; compare against eligible exports and merge at API analyzer boundary. Validate no uncovered builders and real DESCRIBE/schema decoding. C/I/E: high/high/medium.

- `R-PKG19-02` — Central PlanetScale dimension/storage expressions. Evidence: repeated legacy/current identity and used-percent arithmetic across `planetscale-map.ts` and `planetscale-infra.ts`. Add tiny semantic helpers, keeping guards/grouping local and using precedence-aware fragments if `R-LIB02-02` lands. Require compiled SQL equivalence. C/I/E: high/medium/small.

- `R-PKG20-01` — Separate persisted query sets from executable requests. Evidence: permissive stored model, widget/v2 combination and dispatch/list logic. Shape-incompatible fields leak into execution and list silently chooses first enabled query. Keep storage permissive but normalize once to timeseries/breakdown/list execution union; list owns one query. Validate legacy extras and execution parity. C/I/E: high/high/medium-high.

- `R-PKG20-02` — Stable formula aliases through one index. Evidence: positional aliases in `query-builder/model.ts`, web clone/delete renaming and uppercase overwrite in `formula-results.ts`. Deletion can retarget formulas and aliases fail beyond Z. Use stable validated identifiers, collision-free allocation and one case-normalized index; never rename survivors. Validate deletion/chains/collisions/>26 queries. C/I/E: high/high/medium.

- `R-PKG21-01` — Separate source identity, remainder identity and rendering keys. Evidence: line/area/bar positional `sN` visibility keys and `bucket-series.ts` using user label `"Other"` as a sentinel. Reordering can hide another source; real Other can collide. Use structured source/remainder identity plus separate Recharts key. Validate rerenders, rank swaps and real Other conservation. C/I/E: high/high/medium.

- `R-PKG21-02` — Collision-free heatmap grid and semantic hover. Evidence: heatmap concatenates arbitrary coordinates with `::` and stores hover as indexes. Key collisions overwrite cells and changed axes retarget hover. Build a pure nested-map/sparse grid model and store semantic x/y hover. Validate delimiter collisions, axis changes and sparse/all-zero cases. C/I/E: high/medium/medium-low.

- `R-PKG22-01` — Focus trace rows by span ID. Evidence: timeline state/actions store indexes while collapse changes visible indexes; match cursor is independent. Store focused span ID, resolve through existing map and derive search ordinal. Validate collapse around focus and changed match sets. C/I/E: high/medium-high/small-medium.

- `R-PKG22-02` — One trace geometry time domain. Evidence: timeline computes corrected bounds but waterfall/flamegraph/minimap/tooltips normalize against raw start/largest-span duration. Valid spans can disappear or produce non-finite geometry. Extract `TraceTimeDomain` and thread it through geometry consumers. Validate multi-root/skew/zero-duration cross-view parity. C/I/E: high/high/medium.

- `R-PKG23-01` — Revisioned owner for debounced controlled drafts. Evidence: `toolbar.tsx:72-93`, `range-filter-section.tsx:71-137`. Source, draft, timer and router echo use inconsistent logic; pending range can restore externally cleared values. Add small controller with source/draft/edit/submission revisions. Validate external changes and earlier echoes during newer edits. C/I/E: high/high/medium.

- `R-PKG23-02` — Responsive rail lifecycle state. Evidence: `page-layout.tsx:11-79,227-405`. Presence and sheet-open flags are independent, so an absent rail can remain open and reopen later. Use `absent | present{sheetOpen}` controller twice. Validate open→unmount/remount, right/left parity and StrictMode. C/I/E: high/medium/low-medium.

- `R-PKG24-01` — Data source solely owns list request semantics. Evidence: display duplicates list source/filter/limit/root-only; top-errors template already diverges; redaction can expose copied where clause. Stop writing request-bearing display fields, read legacy fallback, strip them from shares and normalize through `R-PKG20-01`. Validate list edit/save and secret redaction. C/I/E: high/high/medium; depends on `R-PKG20-01`.

- `R-PKG24-02` — Retire v1/v2 dashboard compatibility after proof gate. Evidence: `upgrade-to-v3.ts`, incomplete migration chain, dual accessors and permanently empty degradation state. Once every live dashboard/version snapshot is proven v3 and recovery window closes, delete legacy models/upgrader/backfill and simplify parsing/access. Validate every production/staging row before action. C/I/E: medium/high/medium-high; deferred external data gate.

### Libraries

- `R-LIB01-01` — Validated discriminated cache reads. Evidence: `edge-cache.ts:61-67,227-243,413-451`; raw APIs cast external JSON to arbitrary `A`. Use hit-with-value versus value-less miss/timeout/skipped; detailed raw read returns unknown, typed read requires schema and treats decode failure as miss. Validate malformed active-org/quarantine entries. C/I/E: high/medium-high/medium.

- `R-LIB02-01` — Tenant confinement proof per row source. Evidence: [expression marker](lib/clickhouse-builder/src/ch/expr.ts:50), `compile.ts:259-339,382-389`; executor trusts the verdict. A predicate on one source overrides an unscoped join. Track source-specific pins and tenant equality edges; AND combines, OR conservatively intersects; prove every source connected to the same identity. Validate adversarial joins/unions/CTEs. C/I/E: high/very-high/medium-high.

- `R-LIB02-02` — Preserve arithmetic structure to rendering. Evidence: `expr.ts:108-126`, docs’ precedence warning, live Apdex workarounds in `top-operations.ts` and `query-helpers.ts`. Add small binary/grouped fragment nodes and precedence-aware rendering, not a general AST. Audit every mixed arithmetic chain and review fingerprint changes. C/I/E: high/high/medium.

- `R-LIB03-01` — Capture invocation-owned Cloudflare bindings at bind time. Evidence: KV/R2 bind methods defer environment reads; ReplayBlobStore re-provides environment around every call. Resolve once into a concrete client, make missing required bindings typed, and remove environment from operation effects. Start with KV/R2; review service binding separately. Validate two simultaneous environments. C/I/E: high/medium-high/medium.

- `R-LIB04-01` — Preserve domain failures through one mutation bridge. Evidence: `effect-db/electric/handlers.ts` duplicates insert/update/delete adapters and wraps expected errors needed by dashboard conflict handling. Use one internal adapter; throw original expected `E`, wrap defects/interruption in one schema-backed bridge error, centralize txid validation. Validate all three operations and a real dashboard 409. C/I/E: high/high/medium.

- `R-LIB04-02` — Delete unused Atom and optimistic-action models. Evidence: package exports roughly 647 source lines with no tracked consumers; Unitflow/direct mutations are active owners. Remove dead roots/exports/errors/docs after final symbol search. Risk: private but check untracked consumers. Validate effect-db/unitflow/web typechecks and mutation suites. C/I/E: high/medium-high/low.

- `R-LIB05-01` — Remove superseded route-data facade. Evidence: effectRoute/loader/atom/useRouteData exports have no repository callers; app explicitly avoids wrapper for route splitting; staleTime is inert. Retain router/navigation tracing, context, warmAtoms and provider; delete unused parallel model. External publication is the gate. C/I/E: medium/high/low-medium; deferred.

- `R-LIB05-02` — Router-owned Atom registry. Evidence: router and provider independently accept registries; loaders warm one while React may read another. Make the Effect router carry its registry and provider derive it, removing free registry prop. Validate type rejection and preload/read identity. C/I/E: high/medium/low; depends on `R-LIB05-01`.

- `R-LIB09-01` — Revisioned Unitflow query request owner. Evidence: `core/query.ts:77-206`; refresh and dependency pipelines commit unconditionally, append captures old pages/cursor. Use monotonically revisioned replace/append controller and coherent pagination snapshot. Validate old/new, refresh/dependency and append/replace races. C/I/E: high/high/medium.

- `R-LIB09-02` — Distinguish watchdog timeout from lifecycle interruption. Evidence: `unitflow/src/db/index.ts:143-170` turns every failed `Exit` into timeout/stuck while store shutdown is interruption. Use `timeoutOption` so only elapsed deadline triggers recovery and interruption propagates. Validate model-scope close causes no self-heal. C/I/E: high/medium-high/low.

### Operations, generated ownership, docs and examples

- `R-OPS01-01` — Generate all warehouse projections from one snapshot. Evidence: Tinybird/ClickHouse generators rebuild independently; insert mappings can stamp fresh data with an older generated revision; CI omits Tinybird projection. One coordinator builds the manifest once and stages all outputs transactionally. Validate byte/revision consistency and all-output drift. C/I/E: high/high/medium.

- `R-OPS01-02` — Stable CLI UI-asset contract with build-only payload. Evidence: generator overwrites tracked stub, build restores with `git checkout`, MIME truth is duplicated. Keep stable asset/MIME/provider source; inject ignored temporary payload at build time. Validate successful/failed builds leave tracked tree unchanged and embedded headers/bodies match. C/I/E: high/medium/medium.

- `R-OPS02-01` — One cluster-collector activation predicate. Evidence: Fargate activates ConfigMap but Deployment/RBAC/SA/Service omit it. Add chart helper `clusterCollector.enabled && any(receiver)` and use it everywhere. Validate render matrix for every receiver alone/all/none. C/I/E: high/high/low.

- `R-OPS02-02` — One dual-key deployment-environment projection. Evidence: collector emits only legacy `deployment.environment`; instrumentation emits only canonical `.name`; current materializations read legacy. Emit both from one chart helper in all paths. Validate rendered agent/cluster/instrumentation attributes and a representative projected span. C/I/E: high/high/low. Maple telemetry conventions directly shaped this recommendation.

- `R-OPS03-01` — Exact executable LLM vendor delta. Evidence: `sync-llm-upstream.ts` allowlists whole files and skips them during sync; arbitrary content drift passes. Commit one machine-applicable patch/delta, reconstruct upstream+patch and byte-compare. Validate unauthorized edits, added files, overlap failure and clean round-trip. C/I/E: high/high/medium.

- `R-OPS03-02` — Derive native-CLI CI impact from workspace graph. Evidence: `.github/workflows/ci.yml:64-86,545-591`; manual closure omits current cache/primitives/query-model/widgets dependencies. Read manifests to compute closure, preserving semantic/global gates separately. Validate direct/transitive/unrelated/deletion/cycle cases. C/I/E: high/medium-high/medium.

- `R-OPS04-01` — Scoped ingest load-harness resource owner. Evidence: `load_test.rs:30-161`; child/server/monitor/task/path ownership has multiple early-exit leaks and can delete caller-provided paths. Introduce guarded harness resource with explicit queue ownership and ordered always-run shutdown. Validate injected failures and no remaining process/listener. C/I/E: high/medium-high/medium.

- `R-OPS04-02` — Discriminated benchmark artifact. Evidence: `bench-queries.ts:124-139,411-435,634-649,751-945`; failures store NaN aggregates that serialize as null and unchecked readers still dereference them. Persist/schema-decode `Success{nonempty runs,aggregates} | Failure{error}`. Validate round trips, zero/non-finite rejection and comparison combinations. C/I/E: high/medium/small-medium.

- `R-OPS05-01` — One API-documentation owner per truth kind. Evidence: `docs/api-v2.md` claims generated contract authority while documenting obsolete `/rpc` and rollout state; `http-api-migration.md` and current internal API show `/internal`. Keep durable conventions in api-v2, live endpoints in OpenAPI and rollout/history in migration doc. Validate against contract/OpenAPI and stale `/rpc` search. C/I/E: high/high/small.

- `R-OPS07-01` — Typed catalogue for code-consumed instrumentation audit rules. Evidence: `skills/maple-audit/checks.md`, `domain/recommendations.ts`, `setup-audit.ts`, MCP tool and free-form checkId each repeat IDs/keys/severity. Centralize only REN/resource rules and generate marked skill blocks; leave prose-only checks authored. Validate unique IDs, projections and generator check. C/I/E: high/high/medium.

- `R-OPS09-01` — Atomic todo store/cache example state. Evidence: `TodoService.ts:111-123,157-212,246-338`. Separate Refs permit new store with stale cache and delayed read-modify-write loses concurrent changes. Use one `Ref<TodoState>` and synchronous `Ref.modify`, keeping notifications outside. Validate controlled miss/write/toggle/remove interleavings. C/I/E: high/medium/low.

- `R-OPS15-01` — Delete historical one-shot migration generator. Evidence: `gen-error-label-migration.ts:1-54` reads today’s generated snapshot and overwrites migration 0003; registry is now v15. Delete the orphan and make migration provenance comment self-contained without changing statement bytes. Validate no references and exact migration snapshot/replay. C/I/E: high/medium-high/low.

## Explicit skips

- `APP-01` — Four explicit cron branches in `apps/alerting/src/worker.ts:383-446` are exhaustive and tested. A registry would hide clear fail-closed behavior.
- `APP-10` — `apps/mobile/lib/time-utils.ts` is an orphaned placeholder with no manifest/callers/tests. Consolidation would not simplify executable behavior.
- `WEB-05` — Current `panel-types.ts:10-79`, settings registry and cycle tests now provide the previously needed authoritative panel/source model. Remaining branches are real behavior.
- `PKG-14` — `packages/primitives/src/index.ts` is already a flat, direct leaf of branded schemas and small helpers; a data registry would obscure exceptions.
- `PKG-25` — UI package, TypeScript, Vitest and shadcn configurations serve distinct tools; centralization adds indirection.
- `LIB-06` — Vendored LLM core is upstream-owned and already centralizes real common lifecycle logic. Local parser/state refactors would enlarge the fork.
- `LIB-07` — One-export span helper already has one coherent lifecycle and comprehensive tests.
- `LIB-08` — Thinking-orbs lifecycle/presets are coherent vendored behavior; reducer/shared-rAF proposals were speculative and unprofiled.
- `OPS-06` — Static governance/context/editor/brand assets have no executable state or algorithm to simplify.
- `OPS-08` — Alchemy example directly expresses a small pedagogical resource graph; registry extraction would relocate it.
- `OPS-10` — `.context/effect/**` is an upstream reference subtree outside Maple workspaces.
- `OPS-11` — Agent-skill vendor hashes and direct mirrors are intentional and already understandable.
- `OPS-12` — Deepsec’s isolated single-project workspace has one direct configuration and no shared runtime state.
- `OPS-13` — Anti-slop rules are independent AST predicates behind a direct rule map; shared traversal machinery would obscure them.
- `OPS-14` — Root `app.json` is an inert nine-line metadata leaf; deletion is hygiene, not material simplification.
- `OPS-16` — AWS probe and OAuth mock use direct, constrained command/route flows; registries would move straightforward branching.

## Cross-cutting conclusions

The strongest recurring simplifications were:

1. Replace independent flags/nullables with lifecycle unions only where contradictory states are reachable.
2. Tag asynchronous work with identity or revision, and reject stale completions.
3. Decode untrusted data once at the boundary into the model consumers actually require.
4. Keep planning and execution on the same resolved identity—route, query definition, cache plan, schema reconciliation or workflow attempt.
5. Use stable semantic IDs instead of array positions, display labels or concatenated string sentinels.
6. Make one module own resource lifetime: DB connections, native handles, browser writes, Collector retries, harness processes and workflow claims.
7. Generate projections from one immutable source snapshot rather than maintaining synchronized copies.
8. Keep permissive persistence models separate from strict executable models.
9. Prefer small local maps/reducers/unions; reject generic frameworks where branching is already bounded and clear.

## Duplicate, superseded and rejected register

Notable dispositions:

- `R-WEB05-01` — superseded by externally landed panel/source model; WEB-05 changed to skip.
- `R-WEB07-02` — rejected: correlated setters occur within one synchronous React event batch; proposed union was line-count cleanup.
- `R-API06-01` — rejected: the only nonempty version-option producer always constructs the coherent triple.
- `R-PKG11-02` — rejected: generic exact-token machinery exceeded the demonstrated two-template failure mode.
- `R-PKG01-02` — superseded by domain-owned `R-PKG07-02`.
- `R-PKG05-02` — superseded by domain-owned `R-PKG08-02`.
- `R-OPS05-02` — reassigned to `R-OPS09-01` after docs/example boundary split.
- WEB-10 pagination candidate — folded into `R-WEB03-02`.
- WEB MCP tool catalogue duplication — folded into `R-API10-02`.
- PKG-24 executable request union — folded into `R-PKG20-01`.
- LIB-05 stale-time repair — superseded by removing the zero-caller facade.
- OPS-01 manifest-only CI check — superseded by one-snapshot generation.
- OPS-03 four-glob CI hotfix — superseded by graph-derived impact.
- OPS-05 full prose generation — narrowed to explicit ownership of live endpoint/status/phase truth.
- Browser-global OTel coordinator, cross-path schema-apply lock and capture coordinator — deferred because correct ownership spans multiple runtimes and requires an explicit coexistence policy.
- Cache breaker reshaping, trace rAF React state, chart DOM synchronization, preview lifecycle framework, sweep registry, generic eval-harness grade union and the new widget grader’s seven-line panel inference — rejected as below materiality or ownership relocation.

## Audit log summary

- Established an initial 75-row contract, then reviewed every row with bounded non-overlapping agents and coordinator reinspection.
- Fresh coverage audit cross-walked 7,705 tracked paths and rejected the original contract’s broad catch-alls.
- Split docs/examples, product skills, vendored Effect, agent-skill mirrors, Deepsec, anti-slop, root mobile metadata, UI tool configs, historical generator and probes into explicit boundaries, producing the final 86-row contract.
- Independently reopened every worker recommendation before acceptance, narrowing or rejecting speculative abstractions.
- Ran separate fresh passes for coverage, ownership/duplication, materiality, schema completeness and dependency-aware ranking.
- Revalidated 818 finding evidence references across 513 paths at the pre-final snapshot; no missing or out-of-range reference remained. The final two external commits touched only explicitly re-reviewed API-10/OPS-04/OPS-07 files and did not change accepted anchors.
- Final schema pass confirmed 125 unique recommendation IDs, valid confidence enums, complete required fields, correct owners, 16 complete skip records and an acyclic 11-edge graph.
- Final repository state: clean at `20a27225723faaf621e33a216e4e0ac598dfdf45`; audit introduced no changes.