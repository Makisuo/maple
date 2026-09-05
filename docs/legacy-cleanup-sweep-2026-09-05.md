# Legacy cleanup sweep — 2026-09-05

Baseline: `0e8250f2f0` (`refactor: remove retired adapters and error-service facade`).

The useful remaining work is finishing partial migrations to shared patterns. The ordinary
dead-code scan is already clean. Several older implementations remain active beside their
replacements, and a few now produce different behavior.

Scope: repository-wide static scans over 3,625 tracked TypeScript/TSX files, followed by targeted
caller reviews across the API, web/local UI, shared packages, libraries, and CLI. Rust legacy
references were screened, but this was not a full Rust correctness review or a line-by-line
review of every TypeScript file. Findings involving failures were independently checked against
their callers; Effect API checks used the installed `4.0.0-rc.111` implementation.

## Applied in this sweep

- **Logs pagination:** replaced silent next-page failure handling with the stop-on-error behavior
  already used by traces/replays/AI sessions. The scroll sentinel previously retried the same
  failing cursor indefinitely. Pagination now belongs to a filter and first-page snapshot:
  refreshing clears old additional pages and permits retry; old completions cannot release a
  newer request's guard; retained loading results cannot supply an old cursor. The reset uses
  render-time state adjustment, following the existing retained-result pattern, and removes the
  reset effect. See [use-infinite-logs.ts](../apps/web/src/hooks/use-infinite-logs.ts).
- **Span JSON copying:** replaced the custom clipboard promise/state/timer with the existing
  `CopyButton`. Success now follows a successful write, with shared error handling, fallback,
  and timer cleanup. JSON serialization remains lazy. See
  [span-expansion.tsx](../apps/web/src/components/agent-sessions/session-detail/span-expansion.tsx).
- **Database update types:** replaced three untyped update dictionaries and the recommendation
  status helper's untyped parameter with table-derived `Partial<typeof table.$inferInsert>`.
  The touched timestamp initializers use `msToDate`. This restores column/value checks without
  changing the public APIs, updates, or credential-origin guards. Files:
  [IngestAttributeMappingService.ts](../apps/api/src/services/org/IngestAttributeMappingService.ts),
  [ScrapeTargetsService.ts](../apps/api/src/services/integrations/ScrapeTargetsService.ts),
  [RecommendationIssueService.ts](../apps/api/src/services/errors/RecommendationIssueService.ts).

## Highest-value follow-ups

### 1. Unify billing calculations before they disagree further

**Confirmed behavior difference; medium effort; behavior-risk.**

The same `customer`, `plans`, and `usage` feed both calculations in
[billing-section.tsx](../apps/web/src/components/settings/billing-section.tsx), around lines 192–200:

- [cost-estimate.ts](../apps/web/src/lib/billing/cost-estimate.ts):145 uses
  `ceil(overage / billingUnits) * price`.
- [spend.ts](../apps/web/src/lib/billing/spend.ts):201–215 normalizes the rate per unit and calls
  [domain/billing.ts](../packages/domain/src/billing.ts):138, which multiplies continuous usage
  and then rounds cents.

For 12.4 GB of overage at $0.30/GB, the breakdown adds **$3.90**, while the spend model adds
**$3.72**. Both are presented as spend so far in the same cycle. The older calculation also
multiplies subscription quantity; the newer base calculation omits it.

Use one domain pricing result for the breakdown, KPIs, feature cards, and chart. First settle
block rounding, subscription quantities, and unpriceable add-ons: the existing cost-estimate
tests deliberately assert ceiling blocks, so simply switching one function to the other would
silently choose a billing policy. Add parity fixtures covering those cases before removing
the duplicate math.

### 2. Finish timestamp validation at HTTP and CLI boundaries

**Confirmed HTTP failure; medium effort; behavior-risk.**

[TinybirdDateTime](../packages/domain/src/query-engine.ts):15–22 still checks only a regex,
although [WarehouseTimeInput](../packages/query-engine/src/datetime.ts):97–140 checks actual
calendar fields.

The session-authenticated `POST /internal/query-engine/errors-by-type` accepts `startTime` and
`endTime` through `ErrorsByTypeRequest`. An isolated HTTP harness using that schema, the real
query compilation, `resolveCompiledQuery`, and `V1ErrorBoundaryLive` reproduced:

| Input                 | Request decoding | Downstream outcome                      |
| --------------------- | ---------------- | --------------------------------------- |
| `not-a-date`          | Rejected         | 400                                     |
| `2026-13-01 00:00:00` | Accepted         | Compilation defect, sanitized 500       |
| `2026-02-30 00:00:00` | Accepted         | Invalid calendar date compiled into SQL |

Extract the calendar predicate into a lower-level shared primitive and compose it into the
domain schema. Preserve the existing 1–9 fractional digits. Directly aliasing the newer
query-engine schema would create a dependency cycle and can lose nanosecond precision.

The CLI has the related older path:
[core/time.ts](../apps/cli/src/core/time.ts):55–66 returns absolute flags untouched, and
[v2-client.ts](../apps/cli/src/core/v2-client.ts):26 blindly appends `.000Z`.
`resolveRangeChecked` currently accepts `bad`/`worse` as an absolute range. Validate and normalize
once into its documented UTC output, using the existing `TimeRangeError` for invalid arguments.
Keep this behavior consistent across local and remote commands.

### 3. Give chat turns the existing invocation-scoped database connection

**Confirmed missed reuse; small-to-medium effort; behavior-risk.**

[turn-runner.ts](../apps/api/src/chat/turn-runner.ts):357–360 creates a fresh runtime with
`layerPg`, but line 480 runs the program without `withPgConnectionScope`.
[ChatSession.ts](../apps/api/src/chat/ChatSession.ts):354,414–415 calls it as a plain promise;
there is no inherited Effect connection scope. Each tool database callback therefore uses
`DatabasePgLive`'s fresh-client fallback.

Wrap the turn program, including its billing finalizer, in the existing
[withPgConnectionScope](../apps/api/src/platform/pg-connection-scope.ts). Test connection reuse
across multiple tool calls and release on success, failure, and interruption. Audit child-work
lifetime before sharing the connection. The current code is safe but causes repeated dials;
this is not evidence of a fatal database failure.

### 4. Complete shared database execution adoption

**Confirmed duplication; medium effort in small batches; behavior-risk.**

[makeDbExecute](../apps/api/src/platform/db-execute.ts):48 centralizes contention retries,
operation-aware logs, and public error mapping. Older direct-execute/mapper wrappers remain in:

- [DashboardPersistenceService.ts](../apps/api/src/services/dashboards/DashboardPersistenceService.ts):279.
- [OAuthStateRepository.ts](../apps/api/src/services/auth/OAuthStateRepository.ts):30–56.
- [VcsRepository.ts](../apps/api/src/services/integrations/vcs/VcsRepository.ts):185 and its transactions.
- [RecommendationIssueService.ts](../apps/api/src/services/errors/RecommendationIssueService.ts):76.

These omit the shared SQLSTATE `40001`/`40P01` retry behavior and maintain separate log/error
contracts. Migrate single statements and verified whole transactions first. **Do not bulk-wrap
arbitrary callbacks:** retrying a callback with several independently committed statements can
repeat earlier work. Preserve public error tags and dashboard optimistic-concurrency handling.

### 5. Fix metric search synchronization through the shared debounce primitive

**Confirmed navigation race; small-to-medium effort; behavior-risk.**

[metrics-browse.tsx](../apps/web/src/components/metrics/metrics-browse.tsx):49–63 and
[metric-query-controls.tsx](../apps/web/src/components/metrics/metric-query-controls.tsx):70–84
copy prop-to-draft synchronization and timers. An external URL change updates the visible
input but leaves the old timer pending; it can write the previous query back 300–400 ms later.

Use the existing `useDebouncedCallback` and the own-edit echo handling in
[ToolbarSearch](../packages/ui/src/components/toolbar.tsx):73–99. Explicitly cancel pending
commits when an external value supersedes them. **ToolbarSearch itself also lacks that
cancellation**, so replacing the component alone does not fix this race. Test external
navigation while a debounce is pending and a delayed echo during continued typing.

## Further cleanup worth scheduling

| Work                                          | Evidence and intended replacement                                                                                                                                                                                                                                                                                                                                                                    | Risk / size                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Finish pagination lifecycle adoption          | Traces, replays, and AI-session hooks still retain additional pages across a first-page refresh, and old `.finally` blocks clear a shared request ref. Apply the ownership/reset behavior now covered by the logs tests, preserving each endpoint's distinct pagination rules. Current consumers also check React loading state, so duplicate requests are not established merely from the ref flaw. | Behavior-risk / medium                                       |
| Remove redundant sparkline numeric conversion | `packages/query-engine/src/runtime/query-engine.ts:1517–1530` claims there is no row schema and applies `Number(...)`. Compile/decode probes for all four metric types confirmed derived schemas with no untyped columns, including quoted-number decoding. Consume the typed values and delete the stale comment. Audit other conversions individually; raw SQL is different.                       | Safe on verified branch / small                              |
| Finish datetime helper adoption               | Runtime helpers at `query-engine.ts:224–230`, CLI `core/time.ts:16–20`, and millisecond formatters in `AlertsService.ts:288`, `AlertReadModelsService.ts:174`, `CloudflareAnalyticsService.ts:223` duplicate shared datetime helpers. Numerous API Drizzle boundaries also bypass `msToDate`/`dateToMs`. Preserve second vs millisecond vs nanosecond precision and invalid-input guards.            | Formatting often safe; parsing needs caller audit / medium   |
| Remove redundant triage function inputs       | `issue-severity.ts:118` accepts `runId` plus optional `investigationId`; its sole production caller, `apply-diagnosis.ts:146`, supplies the same branded ID twice. Require one investigation ID and update the fixtures. Keep serialized `runId`, outbox fields, and deterministic ID seeds: those remain live contracts.                                                                            | Input cleanup safe only with persisted-output parity / small |
| Migrate query families to definitions         | `QueryEngineService.ts:100` recognizes only logs count/timeseries in `migratedDefinitionFor`; other paths still carry separate compilation and cache metadata. Use `registry/logs.ts` and `query-definition-runner.ts` as the established pattern, one query family at a time. Preserve cache identity, profiles, and capability fallbacks.                                                          | Behavior-risk / large                                        |
| Defer live-query clock reads into execution   | `registry/queries.ts:758` captures `Date.now()` while constructing the compile effect. Resolve `Clock.currentTimeMillis` when that effect runs; retain the existing server-owned window and 15-second cache.                                                                                                                                                                                         | Behavior-risk / small                                        |
| Reuse remaining frontend helpers              | Sharing still has custom clipboard state in `share-dashboard-dialog.tsx:286`; preserve its manual-selection fallback when adopting `useCopy`. Hosted/local log error banners duplicate the same structural component. BYO settings has a local error formatter despite `lib/error-toast.ts` already accepting Exit values.                                                                           | Small separate changes                                       |
| Correct old connection-lifetime comments      | Error/alert tick and retention comments still claim every execute opens a socket. Scoped callers now share a connection. Update those explanations while preserving batching, locks, and ordering.                                                                                                                                                                                                   | Documentation only / small                                   |

## What should stay

- Local-store, archive, browser-session, and ingest-WAL migrations protect persisted data.
- Old OTel attribute readers and dual emits support historical rows and older producers.
- Published browser/Effect SDK deprecations can have callers outside this repository.
- Named pipe dispatch is a current cross-binary protocol, despite its historical naming.
- Dashboard version migrations and public/deep-link compatibility still have real consumers.
- The custom Result shim preserves waiting/timestamp behavior that upstream combinators do not.
- Documented startup imports, compiler workarounds, and database claim-loss markers are intentional.

No `Data.TaggedError` definitions remain in the API. The inspected count projections already
use `::int`; no driver write-result misuse was found. The shared-code scan found no forbidden
`lib` imports of Maple domain code or caller-side `CH.compile(...).orDie` cases.

## Validation

- Knip baseline: `{"issues":[]}`.
- Repository lint audit: zero errors; 5,549 warning diagnostics. These include tests, platform
  adapters, and intentional exceptions; the warning count is not a count of confirmed defects.
- Focused tests: 22 passed across pagination/refresh and shared clipboard suites. Five new
  pagination cases cover failure stopping/retry, refresh clearing, stale request ownership,
  A→B→A filters, and retained loading results.
- API and web typechecks, changed-file lint, and diff whitespace checks passed. An earlier web
  check encountered errors in concurrently edited 3D lab files; the final check passed after
  that separate work changed. The sweep did not modify those files.
- Final React Doctor changed-scope scan against `HEAD`, including untracked files: **100/100,
  no issues**. The broad baseline scan had substantial existing diagnostics, so its score is
  not comparable to changed scope and this does not mean the entire repository is issue-free.

No commit, deployment, database operation, or external issue publication was performed.
