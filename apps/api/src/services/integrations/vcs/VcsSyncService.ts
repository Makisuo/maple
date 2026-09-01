// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
import {
	type BranchEventJob,
	type InstallationSyncJob,
	isInstallationProcessable,
	type PullRequestEventJob,
	type PushJob,
	type SyncCommitsJob,
	type SyncBranchesJob,
	type UnknownVcsProviderError,
	VcsInstallation,
	type VcsProviderError,
	type VcsQueueError,
	type VcsRateLimitedError,
	type VcsRepo,
	type VcsRepoDecodeError,
	type VcsRepoPersistenceError,
	type VcsRepositoryBlockedError,
	type VcsRepoUnavailableError,
	VcsSyncJob,
} from "@maple/domain/http"
import { Clock, Effect, Context, Layer, Option, Schema, Match } from "effect"
import type { VcsProviderClient } from "./VcsProviderClient"
import { PullRequestEventSink } from "./PullRequestEventSink"
import { VcsProviderRegistry } from "./VcsProviderRegistry"
import { VcsRepository } from "./VcsRepository"
import { VcsSyncQueue } from "./VcsSyncQueue"
import { summarizeCause } from "@/platform/describe-cause"

// Vendor-agnostic sync orchestrator. Decodes a queue message, resolves the
// owning installation (→ orgId + provider auth), then dispatches by job kind:
// fetch via the provider port → persist via the repo. The provider port is the
// only provider-specific surface it touches.

// The historical window every branch commit-sync walks — each tracked branch is
// backfilled over the same span. Exported because the dashboard's "track a branch"
// flow (GithubConnectService) enqueues the same jobs.
export const BACKFILL_WINDOW_MS = 90 * 86_400_000 // 90 days
// How many consecutive continuations may fetch zero commits (rate-limited before
// any progress) before we give up. Bounds a permanently throttled installation:
// a transient limit clears long before this, but a wedged one stops requeuing.
export const MAX_BACKFILL_STALL_RETRIES = 10

const decodeJob = Schema.decodeUnknownEffect(VcsSyncJob)

// VcsInstallationGoneError is handled internally (→ disconnect) and never
// surfaces here. VcsProviderError / VcsRepoUnavailableError that aren't caught
// propagate so the queue retries. VcsRateLimitedError propagates from a
// rate-limited fetchRepositories so the consumer redelivers after the delay
// (backfill handles its own rate limits via the resume cursor, not this error).
type SyncError =
	| VcsRepoPersistenceError
	| VcsRepoDecodeError
	| VcsProviderError
	| VcsRepoUnavailableError
	| VcsRateLimitedError
	| VcsQueueError
	| UnknownVcsProviderError

export interface VcsSyncServiceApi {
	readonly processMessage: (raw: unknown) => Effect.Effect<void, SyncError>
	// Last-resort terminal write for a message that has exhausted its queue retries.
	// Total (never fails) so the consumer can call it as a final step without risk.
	readonly recordExhaustedFailure: (raw: unknown) => Effect.Effect<void>
}

export class VcsSyncService extends Context.Service<VcsSyncService, VcsSyncServiceApi>()(
	"@maple/api/services/vcs/VcsSyncService",
	{
		make: Effect.gen(function* () {
			const repo = yield* VcsRepository
			const registry = yield* VcsProviderRegistry
			const queue = yield* VcsSyncQueue
			const sink = yield* PullRequestEventSink

			// The repo's single tracked branch, with the default-branch fallback for a
			// row whose `trackedBranch` was never set (legacy) — the one place the
			// fallback rule lives.
			const trackedBranchOf = (repository: VcsRepo): string =>
				repository.trackedBranch ?? repository.defaultBranch

			const backfillJob = (
				installation: VcsInstallation,
				repository: VcsRepo,
				branch: string,
				sinceMs: number,
			): VcsSyncJob => ({
				kind: "sync-commits",
				provider: installation.provider,
				externalInstallationId: installation.externalInstallationId,
				externalRepoId: repository.externalRepoId,
				owner: repository.owner,
				name: repository.name,
				branch,
				sinceMs,
			})

			// Point the repo at a new tracked branch: wipe its (old-branch) commits and
			// enqueue a fresh backfill of the new branch. Used by the engine's automatic
			// fallback to the default when the tracked branch is deleted upstream.
			const retargetTrackedBranch = Effect.fn("VcsSyncService.retargetTrackedBranch")(function* (
				installation: VcsInstallation,
				repository: VcsRepo,
				newBranch: string,
			) {
				yield* repo.changeTrackedBranch(repository.orgId, repository.id, newBranch)
				const sinceMs = (yield* Clock.currentTimeMillis) - BACKFILL_WINDOW_MS
				yield* queue.send(backfillJob(installation, repository, newBranch, sinceMs))
				yield* Effect.logInfo("[VCS] Tracked branch retargeted to default after deletion").pipe(
					Effect.annotateLogs({
						provider: installation.provider,
						externalRepoId: repository.externalRepoId,
						newBranch,
					}),
				)
			})

			/**
			 * A repository the provider permanently refuses (DMCA/legal block). TERMINAL:
			 * the job drains here so the queue never redelivers it — a single blocked repo
			 * was costing ~12 retries per scheduled run, every 12h, indefinitely. The block
			 * is recorded on the repo row (`sync_status = "error"` + `last_sync_error`), the
			 * span stays Ok with `error.type`, and the operator sees a Warn log.
			 */
			const drainBlockedRepository = (
				installation: VcsInstallation,
				repository: VcsRepo,
				error: VcsRepositoryBlockedError,
				scope: "commits" | "branches",
			) =>
				Effect.annotateCurrentSpan({
					[`vcs.${scope}.outcome`]: "skipped",
					[`vcs.${scope}.reason`]: "repository_blocked",
					"error.type": "vcs_repository_blocked",
					...(error.status !== undefined
						? { "http.response.status_code": error.status }
						: undefined),
				}).pipe(
					Effect.andThen(repo.markRepoSyncError(repository.id, error.message)),
					Effect.andThen(
						Effect.logWarning("[VCS] Repository blocked by provider — sync disabled").pipe(
							Effect.annotateLogs({
								provider: installation.provider,
								externalRepoId: repository.externalRepoId,
								status: error.status,
								"error.message": error.message,
							}),
						),
					),
				)

			const syncCommits = (
				provider: VcsProviderClient,
				installation: VcsInstallation,
				repository: VcsRepo,
				job: SyncCommitsJob,
			) =>
				Effect.gen(function* () {
					// A tracked-branch change wipes the repo's commits and enqueues a fresh
					// backfill, but old-branch jobs survive in the queue (a rate-limited
					// continuation can sit delayed for hours). Drop them — and re-check
					// after the provider fetch below — so a stale job can never repopulate
					// the wiped set, mark it ready, or overwrite the new backfill's status.
					if (job.branch !== trackedBranchOf(repository)) {
						yield* Effect.annotateCurrentSpan({
							"vcs.commits.outcome": "skipped",
							"vcs.commits.reason": "stale_tracked_branch",
						})
						yield* Effect.logInfo(
							"[VCS] Dropping commit sync for a branch no longer tracked",
						).pipe(
							Effect.annotateLogs({
								provider: installation.provider,
								externalRepoId: job.externalRepoId,
								branch: job.branch,
								trackedBranch: trackedBranchOf(repository),
							}),
						)
						return
					}
					// Mark the backfill in progress before the first provider call — the
					// execution path owns every sync_status transition, so this is what the
					// dashboard sees the moment a (re)sync actually starts (e.g. after a
					// tracked-branch change), rather than the enqueue side pre-writing it.
					// Clears any prior error; leaves last_synced_at (last *successful* sync).
					yield* repo.updateRepoSyncStatus(repository.id, {
						status: "backfilling",
						error: null,
					})
					yield* Effect.annotateCurrentSpan({
						"vcs.provider": installation.provider,
						"vcs.repository.id": repository.id,
						"vcs.repository.external_id": job.externalRepoId,
						"vcs.commits.branch": job.branch,
					})
					const now = yield* Clock.currentTimeMillis
					const { commits, next } = yield* provider.fetchCommits(
						installation,
						{
							externalRepoId: job.externalRepoId,
							owner: job.owner,
							name: job.name,
						},
						{
							sinceMs: job.sinceMs,
							branch: job.branch,
							...(!(job.untilMs === undefined) ? { untilMs: job.untilMs } : undefined),
						},
					)

					// Re-read the tracked branch after the provider round-trip: a retarget
					// that committed (wipe + fresh backfill) while we were fetching must
					// invalidate this walk before it writes, or old-branch commits reappear
					// in the freshly reset repo. `None` covers a concurrent purge.
					const current = yield* repo.getRepositoryById(repository.orgId, repository.id)
					if (Option.isNone(current) || trackedBranchOf(current.value) !== job.branch) {
						yield* Effect.annotateCurrentSpan({
							"vcs.commits.outcome": "skipped",
							"vcs.commits.reason": "tracked_branch_changed_mid_fetch",
						})
						return
					}

					// Commits belong to the repo (no branch link), and the repo's commit set
					// is reset up front whenever the tracked branch changes — so a walk just
					// upserts. A force-push re-walk also only upserts: old (rebased-away) SHAs
					// stay for trace attribution.
					yield* repo.upsertCommits(repository, commits)
					yield* Effect.annotateCurrentSpan({ "vcs.commits.fetched": commits.length })

					if (!next) {
						yield* repo.updateRepoSyncStatus(repository.id, {
							status: "ready",
							error: null,
							syncedAt: now,
						})
						yield* Effect.annotateCurrentSpan({
							"vcs.commits.outcome": "handled",
							"vcs.commits.reason": "backfill_complete",
						})
						return
					}

					// No-progress guard: a resume run that fetched commits but didn't move
					// the watermark below the boundary (e.g. >100 commits sharing the exact
					// committer-second) would requeue itself forever. Stop and flag instead.
					if (job.untilMs !== undefined && commits.length > 0 && next.untilMs >= job.untilMs) {
						yield* repo.markRepoSyncError(
							repository.id,
							"backfill stalled: commit-date watermark did not advance",
						)
						yield* Effect.annotateCurrentSpan({
							"vcs.commits.outcome": "stalled",
							"vcs.commits.reason": "watermark_did_not_advance",
						})
						yield* Effect.logError("[VCS] VCS backfill stalled — watermark did not advance").pipe(
							Effect.annotateLogs({
								provider: installation.provider,
								externalRepoId: job.externalRepoId,
								untilMs: job.untilMs,
							}),
						)
						return
					}

					// Stall guard: a run that fetched no commits made no progress (rate-limited
					// before page 1 / at the token mint). Count consecutive such runs and stop
					// once they exceed the cap, so a permanently throttled installation can't
					// requeue forever. Any productive run resets the counter.
					const staleAttempts = commits.length > 0 ? 0 : (job.staleAttempts ?? 0) + 1
					if (staleAttempts > MAX_BACKFILL_STALL_RETRIES) {
						yield* repo.markRepoSyncError(
							repository.id,
							"backfill stalled: rate-limited before making progress",
						)
						yield* Effect.annotateCurrentSpan({
							"vcs.commits.outcome": "stalled",
							"vcs.commits.reason": "rate_limited_before_progress",
							"vcs.commits.stale_attempts": staleAttempts,
						})
						yield* Effect.logError(
							"[VCS] VCS backfill stalled — rate-limited before any progress",
						).pipe(
							Effect.annotateLogs({
								provider: installation.provider,
								externalRepoId: job.externalRepoId,
								staleAttempts,
							}),
						)
						return
					}

					// Cut short mid-walk → checkpoint status + requeue a continuation that
					// resumes from the watermark. Either the provider throttled us (wait
					// out `retryAfterSeconds`) or we hit the per-invocation page budget
					// (delay 0 → continue now); both bound each invocation's wall-clock
					// under the Queues 15-min limit. A fresh job (not a queue retry) keeps
					// the retry budget for genuine failures.
					yield* repo.updateRepoSyncStatus(repository.id, {
						status: "backfilling",
						error: null,
					})
					yield* queue.send(
						{
							...job,
							untilMs: next.untilMs,
							staleAttempts,
						},
						{ delaySeconds: next.retryAfterSeconds },
					)
					yield* Effect.annotateCurrentSpan({
						"vcs.commits.outcome": "handled",
						"vcs.commits.reason":
							next.reason === "page-budget"
								? "continuation_requeued_page_budget"
								: "continuation_requeued_rate_limited",
						"vcs.commits.stale_attempts": staleAttempts,
					})
					yield* Effect.logInfo(
						next.reason === "page-budget"
							? "[VCS] VCS backfill page budget reached — requeued continuation"
							: "[VCS] VCS backfill rate-limited — requeued continuation",
					).pipe(
						Effect.annotateLogs({
							provider: installation.provider,
							externalRepoId: job.externalRepoId,
							untilMs: next.untilMs,
							reason: next.reason,
							delaySeconds: next.retryAfterSeconds,
							staleAttempts,
						}),
					)
				}).pipe(
					// The provider classifies failures; the orchestrator dispatches on the
					// semantic outcome, never on HTTP status:
					//  - VcsRepoUnavailableError (repo gone) → record on the repo and drain.
					//  - VcsInstallationGoneError → propagates to processMessage (disconnect).
					//  - VcsProviderError (transient) → propagates so the queue retries.
					//  - VcsRepositoryBlockedError (legal block) → terminal, drain (never retried).
					Effect.catchTags({
						"@maple/http/errors/VcsRepositoryBlockedError": (error) =>
							drainBlockedRepository(installation, repository, error, "commits"),
						"@maple/http/errors/VcsRepoUnavailableError": (error) =>
							Effect.annotateCurrentSpan({
								"vcs.commits.outcome": "skipped",
								"vcs.commits.reason": "repository_unavailable",
							}).pipe(
								Effect.andThen(repo.markRepoSyncError(repository.id, error.message)),
								Effect.flatMap(() =>
									Effect.logWarning("[VCS] Repository unavailable — backfill skipped").pipe(
										Effect.annotateLogs({
											provider: installation.provider,
											externalRepoId: job.externalRepoId,
										}),
									),
								),
							),
					}),
					Effect.withSpan("VcsSyncService.syncCommits"),
				)

			const applyPush = Effect.fn("VcsSyncService.applyPush")(function* (
				installation: VcsInstallation,
				repository: VcsRepo,
				job: PushJob,
			) {
				const tracked = trackedBranchOf(repository)
				yield* Effect.annotateCurrentSpan({
					"vcs.provider": installation.provider,
					"vcs.repository.id": repository.id,
					"vcs.repository.external_id": repository.externalRepoId,
					"vcs.repository.tracked_branch": tracked,
					"vcs.push.branch": job.branch,
					"vcs.push.forced": job.forced,
				})
				// Surface the pushed branch in the picker even if it's not the tracked one
				// (so a user can switch to a freshly-pushed branch without waiting for the
				// next installation-sync). Commit ingestion is gated on the tracked branch.
				yield* repo.getOrCreateBranch(repository, job.branch)
				if (job.branch !== tracked) {
					// Push landed on an untracked branch — surfaced in the picker, no commit ingestion.
					yield* Effect.annotateCurrentSpan({
						"vcs.push.outcome": "skipped",
						"vcs.push.reason": "untracked_branch",
					})
					return
				}
				// The tracked branch was pushed. A normal push is best-effort enrichment:
				// upsert its commits onto the repo (the backfill remains authoritative).
				if (!job.forced) {
					yield* repo.upsertCommits(repository, job.commits)
					yield* Effect.annotateCurrentSpan({
						"vcs.push.outcome": "handled",
						"vcs.push.reason": "stored",
						"vcs.push.commit_count": job.commits.length,
					})
					return
				}
				// A force-push rewrote history on the tracked branch. The push payload is
				// unreliable after a rewrite, so re-walk the branch instead — old SHAs stay
				// (kept for trace attribution), new commits are upserted.
				const now = yield* Clock.currentTimeMillis
				yield* queue.send(backfillJob(installation, repository, job.branch, now - BACKFILL_WINDOW_MS))
				yield* Effect.annotateCurrentSpan({
					"vcs.push.outcome": "handled",
					"vcs.push.reason": "force_push_rewalk_enqueued",
				})
			})

			// Re-list a repo's branches (the picker's list), reconcile deletions, then
			// enqueue a commit backfill for the repo's single tracked branch — refreshed
			// on every installation-sync. If the tracked branch itself vanished upstream,
			// fall back to the default (wipe + resync) instead. This handler deals in
			// branch *names* only; sync-commits walks the commits.
			const syncBranches = (
				provider: VcsProviderClient,
				installation: VcsInstallation,
				repository: VcsRepo,
			) =>
				Effect.gen(function* () {
					const { branches, truncated } = yield* provider.fetchBranches(installation, {
						externalRepoId: repository.externalRepoId,
						owner: repository.owner,
						name: repository.name,
					})
					yield* repo.upsertBranches(repository, branches)
					const remoteNames = new Set(branches.map((b) => b.name))
					const deletedNames = yield* repo.reconcileBranchDeletions(repository.id, remoteNames, {
						truncated,
					})
					const tracked = trackedBranchOf(repository)
					// The tracked branch vanished (confirmed by a non-truncated re-list that
					// deleted it): retarget to the default and resync. Never when the tracked
					// branch IS the default — there's nothing better to fall back to.
					const trackedDeleted =
						deletedNames.includes(tracked) && tracked !== repository.defaultBranch
					yield* Effect.annotateCurrentSpan({
						"vcs.provider": installation.provider,
						"vcs.repository.external_id": repository.externalRepoId,
						"vcs.branches.listed": branches.length,
						"vcs.branches.truncated": truncated,
						"vcs.branches.tracked": tracked,
						"vcs.branches.tracked_deleted": trackedDeleted,
					})
					if (trackedDeleted) {
						yield* Effect.annotateCurrentSpan({
							"vcs.branches.outcome": "handled",
							"vcs.branches.reason": "tracked_branch_retargeted_to_default",
						})
						yield* retargetTrackedBranch(installation, repository, repository.defaultBranch)
						return
					}
					const sinceMs = (yield* Clock.currentTimeMillis) - BACKFILL_WINDOW_MS
					yield* queue.send(backfillJob(installation, repository, tracked, sinceMs))
					yield* Effect.annotateCurrentSpan({
						"vcs.repository.id": repository.id,
						"vcs.branches.deleted": deletedNames.length,
						"vcs.branches.outcome": "handled",
						"vcs.branches.reason": "tracked_branch_sync_enqueued",
					})
				}).pipe(
					// A repo-scoped fetch failure drains here (branch sync owns no sync_status —
					// that belongs to the commit backfill). Installation-gone propagates to the
					// disconnect handler in processMessage.
					Effect.catchTags({
						"@maple/http/errors/VcsRepositoryBlockedError": (error) =>
							drainBlockedRepository(installation, repository, error, "branches"),
						"@maple/http/errors/VcsRepoUnavailableError": () =>
							Effect.annotateCurrentSpan({
								"vcs.branches.outcome": "skipped",
								"vcs.branches.reason": "repository_unavailable",
							}).pipe(
								Effect.andThen(
									Effect.logWarning(
										"[VCS] Repository unavailable — branch sync skipped",
									).pipe(
										Effect.annotateLogs({
											provider: installation.provider,
											externalRepoId: repository.externalRepoId,
										}),
									),
								),
							),
					}),
					Effect.withSpan("VcsSyncService.syncBranches"),
				)

			// A branch create/delete webhook: mutate the branch table directly (no provider
			// call). Creating a branch just surfaces it in the picker. Deleting one drops
			// its picker row; if it was the repo's tracked branch, fall back to the default
			// (wipe + resync) — unless the tracked branch IS the default, which GitHub
			// renames rather than deletes (the next installation-sync reconciles that).
			const applyBranchEvent = Effect.fn("VcsSyncService.applyBranchEvent")(function* (
				installation: VcsInstallation,
				repository: VcsRepo,
				job: BranchEventJob,
			) {
				yield* Effect.annotateCurrentSpan({
					"vcs.provider": installation.provider,
					"vcs.repository.id": repository.id,
					"vcs.repository.external_id": repository.externalRepoId,
					"vcs.branch_event.action": job.action,
					"vcs.branch_event.branch": job.branch,
				})
				if (job.action === "created") {
					yield* repo.getOrCreateBranch(repository, job.branch)
					yield* Effect.annotateCurrentSpan({
						"vcs.branch_event.outcome": "handled",
						"vcs.branch_event.reason": "branch_upserted",
					})
					return
				}
				const deleted = yield* repo.deleteBranch(repository.id, job.branch)
				if (
					deleted &&
					job.branch === trackedBranchOf(repository) &&
					job.branch !== repository.defaultBranch
				) {
					yield* Effect.annotateCurrentSpan({
						"vcs.branch_event.outcome": "handled",
						"vcs.branch_event.reason": "tracked_branch_retargeted_to_default_after_deletion",
					})
					yield* retargetTrackedBranch(installation, repository, repository.defaultBranch)
					return
				}
				yield* Effect.annotateCurrentSpan({
					"vcs.branch_event.outcome": "handled",
					"vcs.branch_event.reason": deleted ? "branch_deleted" : "branch_absent",
				})
			})

			// Single gate for "should the engine act on this installation?" — rule lives in
			// isInstallationProcessable. Suspended/disconnected installations are skipped.
			const ensureProcessable = Effect.fn("VcsSyncService.ensureProcessable")(function* (
				installation: VcsInstallation,
				kind: VcsSyncJob["kind"],
			) {
				const processable = isInstallationProcessable(installation)
				yield* Effect.annotateCurrentSpan({
					"vcs.installation.status": installation.status,
					"vcs.installation.processable": processable,
				})
				if (!processable) {
					yield* Effect.annotateCurrentSpan({
						"vcs.process.outcome": "skipped",
						"vcs.process.reason": "installation_not_processable",
					})
					yield* Effect.logInfo("[VCS] Skipping VCS job: installation not processable").pipe(
						Effect.annotateLogs({
							provider: installation.provider,
							externalInstallationId: installation.externalInstallationId,
							status: installation.status,
							kind,
						}),
					)
				}
				return processable
			})

			// Resolve the repo a data job targets (external repo id → entity), applying the
			// two drop rules every data job shares — logging + annotating each so the drop is
			// traceable. A `None` result means "drop this job":
			//  - unknown repo (no local row): nothing to attach to.
			//  - soft-removed repo: paused until access is re-granted (which flips it active).
			const resolveRepositoryForJob = Effect.fn("VcsSyncService.resolveRepositoryForJob")(function* (
				installation: VcsInstallation,
				job: PushJob | SyncCommitsJob | SyncBranchesJob | BranchEventJob,
			) {
				const repositoryOpt = yield* repo.resolveRepository(
					installation.orgId,
					job.provider,
					job.externalRepoId,
				)
				if (Option.isNone(repositoryOpt)) {
					yield* Effect.annotateCurrentSpan({
						"vcs.repository.outcome": "dropped",
						"vcs.repository.reason": "unknown_repository",
					})
					yield* Effect.logInfo("[VCS] Dropping VCS job for unknown repository").pipe(
						Effect.annotateLogs({
							provider: job.provider,
							externalRepoId: job.externalRepoId,
							kind: job.kind,
						}),
					)
					return Option.none<VcsRepo>()
				}
				if (repositoryOpt.value.status === "removed") {
					yield* Effect.annotateCurrentSpan({
						"vcs.repository.id": repositoryOpt.value.id,
						"vcs.repository.skipped": true,
						"vcs.repository.outcome": "skipped",
						"vcs.repository.reason": "repository_removed",
					})
					yield* Effect.logInfo("[VCS] Skipping VCS job: repository removed").pipe(
						Effect.annotateLogs({
							provider: job.provider,
							externalRepoId: job.externalRepoId,
							kind: job.kind,
						}),
					)
					return Option.none<VcsRepo>()
				}
				yield* Effect.annotateCurrentSpan({ "vcs.repository.id": repositoryOpt.value.id })
				return repositoryOpt
			})

			// Each owns its own decision-making (the gate, repo resolution, and any
			// reason-specific branching); processMessage only resolves the installation
			// and dispatches by kind.

			const handleInstallationSync = Effect.fn("VcsSyncService.handleInstallationSync")(
				function* (
					provider: VcsProviderClient,
					installation: VcsInstallation,
					job: InstallationSyncJob,
				) {
					yield* Effect.annotateCurrentSpan({
						"vcs.installation.sync_reason": job.reason,
						"vcs.installation.id": installation.id,
						"vcs.installation.external_id": installation.externalInstallationId,
						"vcs.provider": installation.provider,
					})
					// Status-transition reasons change the gate's answer for subsequent jobs
					// rather than processing data themselves.
					if (job.reason === "suspend" || job.reason === "deleted") {
						const status = job.reason === "suspend" ? "suspended" : "disconnected"
						yield* repo.markInstallationStatus(installation.id, status)
						yield* Effect.annotateCurrentSpan({
							"vcs.installation.transition": status,
							"vcs.installation_sync.outcome": "handled",
							"vcs.installation_sync.reason": job.reason,
						})
						return
					}
					let active = installation
					// Reasons that represent a (re)connection or provider re-enable restore the
					// installation to active before the gate, so the sync proceeds. This is what
					// makes the dashboard's reconnect flow actually revive a previously
					// disconnected/suspended row: completeConnect re-enqueues "created"/"updated"
					// for the same external id, and upsertInstallation leaves status untouched on
					// conflict (status is owned here) — so without this it would stay disconnected
					// and the gate below would drop the sync. Idempotent for a fresh install
					// (already active). A bare data refresh (scheduled / repositories_*) must NOT
					// reactivate: a stray webhook can't silently revive an integration the user
					// removed on GitHub.
					const reactivates =
						job.reason === "unsuspend" || job.reason === "created" || job.reason === "updated"
					if (reactivates && installation.status !== "active") {
						// Reflect the new status on the entity we already hold rather than re-reading it.
						yield* repo.markInstallationStatus(installation.id, "active")
						active = new VcsInstallation({ ...installation, status: "active", suspendedAt: null })
						yield* Effect.annotateCurrentSpan({ "vcs.installation.transition": "active" })
					}

					if (!(yield* ensureProcessable(active, job.kind))) {
						yield* Effect.annotateCurrentSpan({
							"vcs.installation_sync.outcome": "skipped",
							"vcs.installation_sync.reason": "installation_not_processable",
						})
						return
					}

					// A newly-created installation gives the org a clean single-installation
					// slate: hard-delete every *other* installation (and its repos/commits) for
					// the same org + provider. A user can remove the old GitHub installation on
					// GitHub's side without Maple ever receiving the `installation.deleted` webhook
					// (delivery isn't guaranteed), stranding a stale "active" row — which would
					// otherwise leave the org with several active installations, a state the
					// dashboard (one active installation per org) does not support. Purge (not just
					// suspend) so nothing lingers. Idempotent: a duplicate "created" — the GitHub
					// webhook and the dashboard callback each enqueue one — finds no siblings left.
					// "updated" (a reconnect) runs the same purge; it just finds nothing to remove.
					if (job.reason === "created" || job.reason === "updated") {
						// Strictly-older siblings only: "supersedes" must be a strict order,
						// or two concurrent created/updated jobs for different installations
						// could each observe the other and mutually purge both. The newest
						// installation wins; the older job finds nothing to remove, and its
						// later writes no-op against the purged row (the repo layer gates
						// child upserts on a live parent).
						const superseded = (yield* repo.listInstallationsByOrg(active.orgId)).filter(
							(other) =>
								other.provider === active.provider &&
								other.id !== active.id &&
								(other.createdAt < active.createdAt ||
									(other.createdAt === active.createdAt && other.id < active.id)),
						)
						if (superseded.length > 0) {
							yield* Effect.forEach(
								superseded,
								(other) => repo.purgeInstallation(active.orgId, other.id),
								{
									discard: true,
								},
							)
							yield* Effect.annotateCurrentSpan({
								"vcs.installation.superseded": superseded.length,
							})
							yield* Effect.logInfo(
								"[VCS] Purged superseded VCS installations after new install",
							).pipe(
								Effect.annotateLogs({
									provider: active.provider,
									externalInstallationId: active.externalInstallationId,
									orgId: active.orgId,
									superseded: superseded.length,
								}),
							)
						}
					}

					const repos = yield* provider.fetchRepositories(active)
					yield* repo.upsertRepositories(installation, repos)
					yield* Effect.annotateCurrentSpan({ "vcs.repositories.reconciled": repos.length })

					// Reconcile removals: soft-delete local repos no longer visible
					// upstream. The row and its synced commits are kept (a re-grant
					// reactivates via upsertRepositories); the "removed" status pauses
					// any further event processing for them. A user must explicitly
					// purge to drop the data. The periodic "scheduled" reconcile runs
					// this too, so it catches a `repositories_removed` webhook we missed.
					if (job.reason === "repositories_removed" || job.reason === "scheduled") {
						const remoteIds = new Set(repos.map((r) => r.externalRepoId))
						const local = yield* repo.listRepositoriesByInstallation(installation.id, "active")
						yield* Effect.forEach(
							local.filter((r) => !remoteIds.has(r.externalRepoId)),
							(r) => repo.markRepositoryRemoved(r.id),
							{ discard: true },
						)
					}

					// Per repo: sync its branch list (names only); sync-branches then enqueues
					// the commit backfill, keeping all commit-sync enqueuing in one place.
					yield* queue.sendBatch(
						repos.map(
							(r): VcsSyncJob => ({
								kind: "sync-branches",
								provider: installation.provider,
								externalInstallationId: installation.externalInstallationId,
								externalRepoId: r.externalRepoId,
								owner: r.owner,
								name: r.name,
							}),
						),
					)
					yield* Effect.annotateCurrentSpan({
						"vcs.installation_sync.outcome": "handled",
						"vcs.installation_sync.reason": job.reason,
					})
				},
				// The repository *listing* is installation-scoped, so a legal block there is
				// not attributable to one repo row — there is nothing to mark. It is still
				// terminal: drain rather than let the queue retry it forever.
				(effect) =>
					Effect.catchTag(effect, "@maple/http/errors/VcsRepositoryBlockedError", (error) =>
						Effect.annotateCurrentSpan({
							"vcs.installation_sync.outcome": "skipped",
							"vcs.installation_sync.reason": "repository_blocked",
							"error.type": "vcs_repository_blocked",
						}).pipe(
							Effect.andThen(
								Effect.logWarning(
									"[VCS] Provider blocked the repository listing — installation sync skipped",
								).pipe(Effect.annotateLogs({ "error.message": error.message })),
							),
						),
					),
			)

			const handleSyncCommits = Effect.fn("VcsSyncService.handleSyncCommits")(function* (
				provider: VcsProviderClient,
				installation: VcsInstallation,
				job: SyncCommitsJob,
			) {
				if (!(yield* ensureProcessable(installation, job.kind))) return
				const repositoryOpt = yield* resolveRepositoryForJob(installation, job)
				if (Option.isNone(repositoryOpt)) return
				yield* syncCommits(provider, installation, repositoryOpt.value, job)
			})

			const handleSyncBranches = Effect.fn("VcsSyncService.handleSyncBranches")(function* (
				provider: VcsProviderClient,
				installation: VcsInstallation,
				job: SyncBranchesJob,
			) {
				if (!(yield* ensureProcessable(installation, job.kind))) return
				const repositoryOpt = yield* resolveRepositoryForJob(installation, job)
				if (Option.isNone(repositoryOpt)) return
				yield* syncBranches(provider, installation, repositoryOpt.value)
			})

			const handlePush = Effect.fn("VcsSyncService.handlePush")(function* (
				installation: VcsInstallation,
				job: PushJob,
			) {
				if (!(yield* ensureProcessable(installation, job.kind))) return
				const repositoryOpt = yield* resolveRepositoryForJob(installation, job)
				if (Option.isNone(repositoryOpt)) return
				yield* applyPush(installation, repositoryOpt.value, job)
			})

			const handleBranchEvent = Effect.fn("VcsSyncService.handleBranchEvent")(function* (
				installation: VcsInstallation,
				job: BranchEventJob,
			) {
				if (!(yield* ensureProcessable(installation, job.kind))) return
				const repositoryOpt = yield* resolveRepositoryForJob(installation, job)
				if (Option.isNone(repositoryOpt)) return
				yield* applyBranchEvent(installation, repositoryOpt.value, job)
			})

			/**
			 * A pull request changed. Unlike every other handler this one persists
			 * nothing here — it resolves the owning org and forwards to the sink,
			 * which owns the issue link and the verification window.
			 *
			 * Deliberately NOT behind `ensureProcessable`: that gate asks whether a
			 * repository is synced, and a PR can name an issue in a repository this
			 * org never asked Maple to index. Requiring a synced repo would drop
			 * exactly the link a user most wants.
			 */
			const handlePullRequestEvent = Effect.fn("VcsSyncService.handlePullRequestEvent")(function* (
				installation: VcsInstallation,
				job: PullRequestEventJob,
			) {
				yield* Effect.annotateCurrentSpan({
					"vcs.repository.external_id": job.externalRepoId,
					"vcs.pull_request.number": job.number,
					"vcs.pull_request.action": job.action,
					"vcs.pull_request.merged": job.merged,
				})
				yield* sink.onPullRequestEvent(installation.orgId, job)
			})

			const processMessage = Effect.fn("VcsSyncService.processMessage")(function* (raw: unknown) {
				const jobOpt = yield* decodeJob(raw).pipe(
					Effect.map(Option.some),
					Effect.catch((cause) =>
						Effect.annotateCurrentSpan({
							"vcs.process.outcome": "dropped",
							"vcs.process.reason": "job_undecodable",
						}).pipe(
							Effect.andThen(
								Effect.logWarning("[VCS] Dropping undecodable VCS sync job").pipe(
									Effect.annotateLogs({ error: String(cause) }),
								),
							),
							Effect.as(Option.none<VcsSyncJob>()),
						),
					),
				)
				if (Option.isNone(jobOpt)) return
				const job = jobOpt.value
				yield* Effect.annotateCurrentSpan({
					"vcs.provider": job.provider,
					"vcs.job.kind": job.kind,
					"vcs.installation.external_id": job.externalInstallationId,
				})
				// Correlate back to the originating webhook: webhook-origin jobs carry the
				// provider delivery id, which the webhook receive span also recorded as
				// `vcs.webhook.delivery_id`. Absent on cron/internally-enqueued jobs.
				if ("deliveryId" in job && job.deliveryId !== undefined) {
					yield* Effect.annotateCurrentSpan({ "vcs.webhook.delivery_id": job.deliveryId })
				}

				// Resolve the installation once (external id → entity); every handler uses
				// `installation.id` from here on.
				const installationOpt = yield* repo.resolveInstallation(
					job.provider,
					job.externalInstallationId,
				)
				if (Option.isNone(installationOpt)) {
					yield* Effect.annotateCurrentSpan({
						"vcs.process.outcome": "dropped",
						"vcs.process.reason": "installation_unknown",
					})
					yield* Effect.logInfo("[VCS] Dropping VCS job for unknown installation").pipe(
						Effect.annotateLogs({
							provider: job.provider,
							externalInstallationId: job.externalInstallationId,
							kind: job.kind,
						}),
					)
					return
				}
				const installation = installationOpt.value
				yield* Effect.annotateCurrentSpan({ "vcs.installation.id": installation.id })

				const provider = yield* registry.resolve(job.provider)

				yield* Effect.annotateCurrentSpan({
					"vcs.process.outcome": "dispatched",
					"vcs.process.reason": job.kind,
				})

				// Dispatch by kind — each handler owns the gate, repo resolution, and all
				// decision-making for its job. No kind-specific branching lives here.
				const run = Match.value(job).pipe(
					Match.discriminator("kind")("installation-sync", (job) =>
						handleInstallationSync(provider, installation, job),
					),
					Match.discriminator("kind")("sync-commits", (job) =>
						handleSyncCommits(provider, installation, job),
					),
					Match.discriminator("kind")("sync-branches", (job) =>
						handleSyncBranches(provider, installation, job),
					),
					Match.discriminator("kind")("push", (job) => handlePush(installation, job)),
					Match.discriminator("kind")("branch-event", (job) =>
						handleBranchEvent(installation, job),
					),
					Match.discriminator("kind")("pull-request-event", (job) =>
						handlePullRequestEvent(installation, job),
					),
					Match.exhaustive,
				)

				// The ONE place an installation is disconnected, and only on the provider's
				// authoritative gone signal — never on a raw HTTP status.
				return yield* run.pipe(
					Effect.catchTag("@maple/http/errors/VcsInstallationGoneError", () =>
						Effect.annotateCurrentSpan({
							"vcs.process.outcome": "handled",
							"vcs.process.reason": "installation_gone",
							"vcs.installation.transition": "disconnected",
						}).pipe(
							Effect.andThen(repo.markInstallationStatus(installation.id, "disconnected")),
							Effect.flatMap(() =>
								Effect.logWarning(
									"[VCS] VCS installation reported gone by provider — marked disconnected",
								).pipe(
									Effect.annotateLogs({
										provider: installation.provider,
										externalInstallationId: installation.externalInstallationId,
									}),
								),
							),
						),
					),
				)
			})

			// Called by the queue consumer when a message has run out of retries (about
			// to be dropped — there is no dead-letter queue). For a commit-sync job this
			// records a terminal `error` status so a repo can never get stuck showing
			// "backfilling" after the engine has given up; the periodic installation-sync
			// will later attempt a fresh backfill. Other job kinds own no `sync_status`,
			// so they're a no-op. Total + best-effort: every internal failure is swallowed
			// and logged, since this runs as the consumer's very last step.
			const recordExhaustedFailure = (raw: unknown) =>
				Effect.gen(function* () {
					const jobOpt = yield* decodeJob(raw).pipe(
						Effect.map(Option.some),
						Effect.orElseSucceed(() => Option.none<VcsSyncJob>()),
					)
					if (Option.isNone(jobOpt) || jobOpt.value.kind !== "sync-commits") {
						yield* Effect.annotateCurrentSpan({
							"vcs.exhausted.outcome": "noop",
							"vcs.exhausted.reason": "not_sync_commits_job",
						})
						return
					}
					const job = jobOpt.value
					yield* Effect.annotateCurrentSpan({
						"vcs.provider": job.provider,
						"vcs.job.kind": job.kind,
						"vcs.repository.external_id": job.externalRepoId,
					})
					const installationOpt = yield* repo.resolveInstallation(
						job.provider,
						job.externalInstallationId,
					)
					if (Option.isNone(installationOpt)) {
						yield* Effect.annotateCurrentSpan({
							"vcs.exhausted.outcome": "noop",
							"vcs.exhausted.reason": "installation_unknown",
						})
						return
					}
					const repositoryOpt = yield* resolveRepositoryForJob(installationOpt.value, job)
					if (Option.isNone(repositoryOpt)) {
						yield* Effect.annotateCurrentSpan({
							"vcs.exhausted.outcome": "noop",
							"vcs.exhausted.reason": "repository_unresolved",
						})
						return
					}
					// An exhausted job for a branch no longer tracked must not flag the NEW
					// branch's backfill as errored — the stale walk it represents is moot.
					if (job.branch !== trackedBranchOf(repositoryOpt.value)) {
						yield* Effect.annotateCurrentSpan({
							"vcs.exhausted.outcome": "noop",
							"vcs.exhausted.reason": "stale_tracked_branch",
						})
						return
					}
					yield* repo.markRepoSyncError(
						repositoryOpt.value.id,
						"backfill failed: exhausted queue retries",
					)
					yield* Effect.annotateCurrentSpan({
						"vcs.repository.id": repositoryOpt.value.id,
						"vcs.exhausted.outcome": "handled",
						"vcs.exhausted.reason": "repo_marked_errored",
					})
					yield* Effect.logError(
						"[VCS] VCS commit sync exhausted retries — marked repo errored",
					).pipe(
						Effect.annotateLogs({
							provider: job.provider,
							externalRepoId: job.externalRepoId,
						}),
					)
				}).pipe(
					// Annotate + log inside the span, then let the cause through `withSpan` so
					// the span exits Error and this failure reaches error analytics. Swallowing
					// it before the span (the obvious shape) leaves a terminal write failure
					// visible only as a log line. The catch sits OUTSIDE the span so the effect
					// stays total for the consumer, which calls this as its very last step.
					Effect.tapCause((cause) =>
						Effect.annotateCurrentSpan({
							"vcs.exhausted.outcome": "failed",
							"vcs.exhausted.reason": "record_failed",
						}).pipe(
							Effect.andThen(
								Effect.logError("[VCS] Failed to record exhausted VCS sync failure").pipe(
									Effect.annotateLogs({ error: summarizeCause(cause) }),
								),
							),
						),
					),
					Effect.withSpan("VcsSyncService.recordExhaustedFailure"),
					Effect.ignoreCause,
				)

			return { processMessage, recordExhaustedFailure } satisfies VcsSyncServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
