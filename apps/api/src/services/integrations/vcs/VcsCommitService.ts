import {
	type CommitUpsertInput,
	GitCommitSha,
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	isInstallationProcessable,
	type OrgId,
	type VcsCommit,
	type VcsInstallation,
	VcsCommitNotFoundError,
	VcsCommitShaInvalidError,
	type VcsProviderId,
	type VcsRepo,
} from "@maple/domain/http"
import { Clock, Context, Effect, Layer, Option, Result, Schema } from "effect"
import { VcsProviderRegistry } from "./VcsProviderRegistry"
import { VcsRepository } from "./VcsRepository"

// Resolves a commit by SHA for the dashboard's hover card — entirely vendor-
// agnostic. It only ever talks to `VcsRepository` (storage) and a
// `VcsProviderClient` obtained from the registry; it never imports a provider
// module. Adding a provider needs no change here.
//
// The SHA comes from telemetry (`deployment.commit_sha`) and carries no repo
// association, so resolution is by SHA across the whole org:
//   1. stored?  → return the DB row (the common, fast path)
//   2. else     → probe each connected repo via `provider.fetchCommit` until one
//                 resolves, persist it, and return it
//   3. else     → not found (cached briefly so repeated hovers don't re-probe)

// How long a "not found" result is cached. Short because a backfill may land
// the commit moments later, but long enough to absorb hover-card bursts.
const NEGATIVE_TTL_MS = 60_000

const NEGATIVE_CACHE_MAX = 1000
const NEGATIVE_CACHE_TARGET = 900

const evictNegativeCache = (cache: Map<string, number>, now: number): void => {
	if (cache.size < NEGATIVE_CACHE_MAX) return
	for (const [key, expiry] of cache) {
		if (expiry <= now) cache.delete(key)
	}
	// Still too big? Drop the oldest entries (Maps iterate in insertion order).
	if (cache.size > NEGATIVE_CACHE_TARGET) {
		for (const key of cache.keys()) {
			if (cache.size <= NEGATIVE_CACHE_TARGET) break
			cache.delete(key)
		}
	}
}

interface VcsCommitDetail {
	readonly provider: VcsProviderId
	readonly sha: GitCommitSha
	readonly message: string
	readonly authorName: string | null
	readonly authorEmail: string | null
	readonly authorLogin: string | null
	readonly authorAvatarUrl: string | null
	readonly authoredAt: number | null
	readonly committedAt: number
	readonly htmlUrl: string
	readonly repoFullName: string
	readonly resolved: "stored" | "fetched"
}

export interface VcsCommitServiceShape {
	readonly resolveCommitDetail: (
		orgId: OrgId,
		sha: string,
	) => Effect.Effect<
		VcsCommitDetail,
		| VcsCommitShaInvalidError
		| VcsCommitNotFoundError
		| IntegrationsNotConnectedError
		| IntegrationsUpstreamError
		| IntegrationsPersistenceError
	>
	/**
	 * Resolve many SHAs at once for list views (the services table renders one
	 * deploy row per service/environment). Unresolvable SHAs — invalid, unknown,
	 * or belonging to no connected repo — are simply omitted rather than failing
	 * the batch, so one bad deploy reference can't blank out the whole table.
	 */
	readonly resolveCommitDetails: (
		orgId: OrgId,
		shas: ReadonlyArray<string>,
	) => Effect.Effect<ReadonlyArray<VcsCommitDetail>, IntegrationsPersistenceError>
}

/**
 * How many unknown SHAs we probe against providers for one bulk request. Stored
 * SHAs are free (two reads for the whole batch); a probe is an outbound provider
 * call per SHA, and outbound call count — not the cost of any single call — is
 * what drives this worker's latency. A list view that would blow past this is
 * showing deploys we've never ingested, which is a backfill problem, not a
 * hover-card one.
 */
const BULK_PROBE_LIMIT = 8
/** Concurrency for those probes — matches the bucket-cache fill concurrency. */
const BULK_PROBE_CONCURRENCY = 4

// Storage / decode errors all carry a `message`; collapse them to the
// persistence error the HTTP layer speaks.
const asPersistence = <A, E extends { readonly message: string }>(
	eff: Effect.Effect<A, E>,
): Effect.Effect<A, IntegrationsPersistenceError> =>
	eff.pipe(Effect.mapError((error) => new IntegrationsPersistenceError({ message: error.message })))

const decodeSha = Schema.decodeUnknownEffect(GitCommitSha)

const detailFromCommit = (commit: VcsCommit, repoFullName: string): VcsCommitDetail => ({
	provider: commit.provider,
	sha: commit.sha,
	message: commit.message,
	authorName: commit.authorName,
	authorEmail: commit.authorEmail,
	authorLogin: commit.authorLogin,
	authorAvatarUrl: commit.authorAvatarUrl,
	authoredAt: commit.authoredAt,
	committedAt: commit.committedAt,
	htmlUrl: commit.htmlUrl,
	repoFullName,
	resolved: "stored",
})

const detailFromInput = (
	input: CommitUpsertInput,
	repository: VcsRepo,
	sha: GitCommitSha,
): VcsCommitDetail => ({
	provider: repository.provider,
	sha,
	message: input.message,
	authorName: input.authorName,
	authorEmail: input.authorEmail,
	authorLogin: input.authorLogin,
	authorAvatarUrl: input.authorAvatarUrl,
	authoredAt: input.authoredAt,
	committedAt: input.committedAt,
	htmlUrl: input.htmlUrl,
	repoFullName: repository.fullName,
	resolved: "fetched",
})

export class VcsCommitService extends Context.Service<VcsCommitService, VcsCommitServiceShape>()(
	"@maple/api/services/vcs/VcsCommitService",
	{
		make: Effect.gen(function* () {
			const repo = yield* VcsRepository
			const registry = yield* VcsProviderRegistry
			// Remembers SHAs no repo has (orgId:sha → expiry ms) so we don't re-probe on
			// every hover. Per-isolate and size-capped by evictNegativeCache.
			const negativeCache = new Map<string, number>()

			const probeInstallations = Effect.fn("VcsCommitService.probeInstallations")(function* (
				orgId: OrgId,
				sha: GitCommitSha,
				installations: ReadonlyArray<VcsInstallation>,
			) {
				// `reposProbed` accumulates across the whole walk; it's reported in both
				// the resolved and not-found outcomes. `found` carries the first repo that
				// resolves and, once set, makes every later iteration a no-op — so no extra
				// `fetchCommit` runs after a hit and the counter stops advancing, preserving
				// the original early-`return` semantics exactly (forEach merely walks, but
				// skips, the remaining items).
				let reposProbed = 0
				const hit: {
					current: {
						readonly normalized: CommitUpsertInput
						readonly repository: VcsRepo
						readonly reposProbed: number
					} | null
				} = { current: null }

				yield* Effect.forEach(installations, (installation) =>
					Effect.gen(function* () {
						if (hit.current !== null) return
						const provider = yield* registry
							.resolve(installation.provider)
							.pipe(
								Effect.mapError((e) => new IntegrationsUpstreamError({ message: e.message })),
							)
						const repos = yield* asPersistence(
							repo.listRepositoriesByInstallation(installation.id, "active"),
						)
						yield* Effect.forEach(repos, (repository) =>
							Effect.gen(function* () {
								if (hit.current !== null) return
								reposProbed += 1
								const outcome = yield* Effect.result(
									provider.fetchCommit(
										installation,
										{
											externalRepoId: repository.externalRepoId,
											owner: repository.owner,
											name: repository.name,
										},
										sha,
									),
								)

								if (Result.isFailure(outcome)) {
									// Best-effort: skip repos that error; another may have the commit.
									return
								}
								if (Option.isNone(outcome.success)) return

								yield* Effect.annotateCurrentSpan({
									"vcs.commit.repos_probed": reposProbed,
									"vcs.commit.provider": installation.provider,
									"vcs.commit.outcome": "resolved",
									"vcs.repository.id": repository.id,
								})
								hit.current = {
									normalized: outcome.success.value,
									repository,
									reposProbed,
								}
							}),
						)
					}),
				)

				if (hit.current !== null) {
					return {
						_tag: "resolved" as const,
						normalized: hit.current.normalized,
						repository: hit.current.repository,
						reposProbed: hit.current.reposProbed,
					}
				}

				yield* Effect.annotateCurrentSpan({
					"vcs.commit.repos_probed": reposProbed,
					"vcs.commit.outcome": "not_found",
				})
				return { _tag: "not_found" as const, reposProbed } as const
			})

			const resolveCommitDetail = Effect.fn("VcsCommitService.resolveCommitDetail")(function* (
				orgId: OrgId,
				rawSha: string,
			) {
				yield* Effect.annotateCurrentSpan({ orgId })

				// Unguarded telemetry SHA: a non-40-hex value is a typed, non-retryable
				// error the dashboard renders as a muted "non-standard reference".
				const sha = yield* decodeSha(rawSha).pipe(
					Effect.mapError(
						() =>
							new VcsCommitShaInvalidError({
								message:
									"Commit reference is not a 40-character hex SHA — it may be a short SHA or a non-standard deployment identifier.",
								sha: rawSha,
							}),
					),
					Effect.tapError(() =>
						Effect.annotateCurrentSpan({
							"vcs.commit.outcome": "rejected",
							"vcs.commit.reason": "invalid_sha",
						}),
					),
				)
				yield* Effect.annotateCurrentSpan({ "vcs.commit.sha": sha })

				// 1. Fast path — already stored.
				const storedOpt = yield* asPersistence(repo.findCommitBySha(orgId, sha))
				if (Option.isSome(storedOpt)) {
					const stored = storedOpt.value
					const repoOpt = yield* asPersistence(repo.getRepositoryById(orgId, stored.repositoryId))
					const repoFullName = Option.match(repoOpt, {
						onNone: () => "",
						onSome: (r) => r.fullName,
					})
					yield* Effect.annotateCurrentSpan({
						"vcs.commit.outcome": "resolved",
						"vcs.commit.reason": "stored_hit",
						"vcs.commit.source": "stored",
						"vcs.repository.id": stored.repositoryId,
					})
					return detailFromCommit(stored, repoFullName)
				}

				const cacheKey = `${orgId}:${sha}`
				const now = yield* Clock.currentTimeMillis
				const cachedUntil = negativeCache.get(cacheKey)
				if (cachedUntil !== undefined && cachedUntil > now) {
					yield* Effect.annotateCurrentSpan({
						"vcs.commit.outcome": "not_found",
						"vcs.commit.reason": "negative_cache_hit",
						"vcs.commit.source": "cache",
					})
					return yield* new VcsCommitNotFoundError({
						message: "No connected repository contains this commit.",
						sha,
					})
				}
				if (cachedUntil !== undefined) negativeCache.delete(cacheKey)

				// 2. Resolve on the fly. Only processable (active) installations count.
				const installations = (yield* asPersistence(repo.listInstallationsByOrg(orgId))).filter(
					isInstallationProcessable,
				)
				yield* Effect.annotateCurrentSpan({ "vcs.commit.installations_probed": installations.length })
				if (installations.length === 0) {
					yield* Effect.annotateCurrentSpan({
						"vcs.commit.outcome": "rejected",
						"vcs.commit.reason": "not_connected",
					})
					return yield* new IntegrationsNotConnectedError({
						message: "No VCS provider is connected for this organization.",
					})
				}

				const probe = yield* probeInstallations(orgId, sha, installations)
				yield* Effect.annotateCurrentSpan({
					"vcs.commit.source": "probe",
					"vcs.commit.repos_probed": probe.reposProbed,
				})

				if (probe._tag === "resolved") {
					// Persist best-effort — a write failure must not fail the read.
					const { normalized, repository } = probe
					const persisted = yield* asPersistence(repo.upsertCommits(repository, [normalized])).pipe(
						Effect.as(true),
						Effect.catch((e) =>
							Effect.logWarning("[VCS] Resolved commit but failed to persist it").pipe(
								Effect.annotateLogs({
									orgId,
									"vcs.commit.sha": sha,
									"vcs.commit.reason": "persist_failed",
									error: e.message,
								}),
								Effect.as(false),
							),
						),
					)
					yield* Effect.annotateCurrentSpan({
						"vcs.commit.outcome": "resolved",
						"vcs.commit.reason": persisted ? "resolved_via_probe" : "persist_failed",
						"vcs.repository.id": repository.id,
					})
					return detailFromInput(normalized, repository, sha)
				}

				// No repo had it — remember that briefly. Trim first to stay bounded.
				evictNegativeCache(negativeCache, now)
				negativeCache.set(cacheKey, now + NEGATIVE_TTL_MS)
				yield* Effect.annotateCurrentSpan({
					"vcs.commit.outcome": "not_found",
					"vcs.commit.reason": "not_found",
				})
				return yield* new VcsCommitNotFoundError({
					message: "No connected repository contains this commit.",
					sha,
				})
			})

			const resolveCommitDetails = Effect.fn("VcsCommitService.resolveCommitDetails")(function* (
				orgId: OrgId,
				rawShas: ReadonlyArray<string>,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "vcs.commit.requested": rawShas.length })

				// Non-40-hex references (short SHAs, non-standard deploy ids) are
				// dropped silently here. The singular endpoint still reports them as
				// VcsCommitShaInvalidError; in a list they're just rows that render
				// their raw reference, which is what the table does anyway.
				const shas: Array<GitCommitSha> = []
				const seen = new Set<string>()
				for (const raw of rawShas) {
					if (seen.has(raw)) continue
					seen.add(raw)
					const decoded = yield* decodeSha(raw).pipe(Effect.option)
					if (Option.isSome(decoded)) shas.push(decoded.value)
				}
				if (shas.length === 0) return [] as ReadonlyArray<VcsCommitDetail>

				// 1. One read for every stored commit, then one read for the repos they
				//    belong to — two outbound calls for the whole batch.
				const stored = yield* asPersistence(repo.findCommitsByShas(orgId, shas))
				const repositories = yield* asPersistence(
					repo.getRepositoriesByIds(
						orgId,
						stored.map((commit) => commit.repositoryId),
					),
				)
				const repoNameById = new Map(repositories.map((r) => [r.id, r.fullName]))
				const details = stored.map((commit) =>
					detailFromCommit(commit, repoNameById.get(commit.repositoryId) ?? ""),
				)

				// 2. Probe the misses, bounded. Each probe reuses the singular path so
				//    negative caching and persistence behave identically.
				const storedShas = new Set(stored.map((commit) => commit.sha))
				const missing = shas.filter((sha) => !storedShas.has(sha)).slice(0, BULK_PROBE_LIMIT)
				yield* Effect.annotateCurrentSpan({
					"vcs.commit.stored_hits": stored.length,
					"vcs.commit.probed": missing.length,
				})

				const probed = yield* Effect.forEach(
					missing,
					// A miss is the normal case for an unconnected repo — never fail the batch.
					(sha) => resolveCommitDetail(orgId, sha).pipe(Effect.option),
					{ concurrency: BULK_PROBE_CONCURRENCY },
				)

				return [...details, ...probed.filter(Option.isSome).map((option) => option.value)]
			})

			return { resolveCommitDetail, resolveCommitDetails } satisfies VcsCommitServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
