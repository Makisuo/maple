import {
	type BranchUpsertInput,
	type CommitUpsertInput,
	GitCommitSha,
	type RepoUpsertInput,
	type VcsInstallation,
	VcsInstallationGoneError,
	type VcsInstallationSyncReason,
	VcsProviderError,
	type VcsProviderId,
	VcsRateLimitedError,
	type VcsRepositoryRef,
	VcsRepoUnavailableError,
	type VcsSyncJob,
	VcsWebhookParseError,
	VcsWebhookSignatureError,
} from "@maple/domain/http"
import { Clock, Context, Effect, Layer, Match, Option, Redacted, Schema } from "effect"
import { Env } from "../../../../lib/Env"
import type { VcsProviderClient, VcsWebhookRequest } from "../../VcsProviderClient"
import { QUEUE_MESSAGE_LIMIT_BYTES } from "../../VcsSyncQueue"
import { type GithubApiCommit, GithubAppClient, GithubAppError } from "./GithubAppClient"

const PROVIDER: VcsProviderId = "github"

// GitHub allows up to 2048 commits per push delivery and commit messages are
// unbounded, so neither a single inline job nor a fixed commit *count* can
// guarantee staying under the queue's message cap (a squash/merge commit alone
// can carry a multi-KB message). So commits are packed into jobs by encoded byte
// size, reserving headroom below the cap (QUEUE_MESSAGE_LIMIT_BYTES, owned by the
// queue layer) for the job envelope and the queue's own serialization. Pushes are
// independent and idempotent (commits upsert by unique index), so splitting across
// jobs is safe and order-independent.
const PUSH_JOB_MAX_BYTES = QUEUE_MESSAGE_LIMIT_BYTES - 16 * 1024 // 16 KB reserve ⇒ 112 KB target

// ---- Webhook payload schemas (minimal, permissive) ------------------------

const PushAuthor = Schema.Struct({
	name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	email: Schema.optionalKey(Schema.NullOr(Schema.String)),
	username: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

const PushCommit = Schema.Struct({
	id: GitCommitSha, // validated at decode — the 40-hex shape lives in the brand
	message: Schema.String,
	timestamp: Schema.optionalKey(Schema.String),
	url: Schema.String,
	author: Schema.optionalKey(PushAuthor),
})

const PushPayload = Schema.Struct({
	ref: Schema.String,
	repository: Schema.Struct({
		id: Schema.Number,
		owner: Schema.Struct({
			login: Schema.optionalKey(Schema.String),
			name: Schema.optionalKey(Schema.NullOr(Schema.String)),
		}),
	}),
	installation: Schema.Struct({ id: Schema.Number }),
	// GitHub sets `forced: true` for a force-push (rebase / history rewrite).
	forced: Schema.optionalKey(Schema.Boolean),
	commits: Schema.optionalKey(Schema.Array(PushCommit)),
})

const InstallationPayload = Schema.Struct({
	action: Schema.String,
	installation: Schema.Struct({ id: Schema.Number }),
})

// `create` / `delete` events: a branch (or tag) was created/deleted. `ref` is the
// bare name (NOT refs/heads/…); `ref_type` distinguishes a branch from a tag.
const RefEventPayload = Schema.Struct({
	ref: Schema.String,
	ref_type: Schema.String,
	repository: Schema.Struct({ id: Schema.Number }),
	installation: Schema.Struct({ id: Schema.Number }),
})

const decodePush = Schema.decodeUnknownEffect(PushPayload)
const decodeInstallationEvent = Schema.decodeUnknownEffect(InstallationPayload)
const decodeRefEvent = Schema.decodeUnknownEffect(RefEventPayload)

const parseError = (message: string) => new VcsWebhookParseError({ message })

// Decode an event payload, logging the structured cause server-side (so schema
// drift is diagnosable) while returning a generic 400-mapped error to the caller.
// The child span carries the event and (on failure) the stable `invalid_payload`
// parse-error reason so a schema-drift rejection is filterable from a trace.
const parsePayload = <A, E>(event: string, decoded: Effect.Effect<A, E>) =>
	decoded.pipe(
		Effect.tapError((cause) =>
			Effect.gen(function* () {
				yield* Effect.annotateCurrentSpan({
					"vcs.webhook.outcome": "rejected",
					"vcs.webhook.parse_error": "invalid_payload",
				})
				yield* Effect.logWarning("[GitHub] Invalid GitHub webhook payload").pipe(
					Effect.annotateLogs({ provider: PROVIDER, event, cause: String(cause) }),
				)
			}),
		),
		Effect.mapError(() => parseError(`Invalid ${event} payload`)),
		Effect.withSpan("GithubProvider.parsePayload", {
			attributes: { "vcs.provider": PROVIDER, "vcs.webhook.event": event },
		}),
	)

// Classify a GitHub HTTP failure into a semantic VCS error. HTTP-status
// knowledge lives here, in the provider — the orchestrator only ever sees the
// semantic outcome. A rate limit (carrying `retryAfterSeconds`) becomes a
// VcsRateLimitedError; a gone/410 on the installation-auth call is the
// authoritative disconnect signal; on a repo call it means the repo is gone;
// everything else (incl. 401/403/5xx) is transient and retryable.
const isGone = (status?: number) => status === 404 || status === 410

const toVcsError = (
	error: GithubAppError,
): VcsProviderError | VcsInstallationGoneError | VcsRepoUnavailableError | VcsRateLimitedError => {
	if (error.retryAfterSeconds !== undefined) {
		return new VcsRateLimitedError({
			message: error.message,
			retryAfterSeconds: error.retryAfterSeconds,
		})
	}
	if (isGone(error.status)) {
		if (error.scope === "installation") return new VcsInstallationGoneError({ message: error.message })
		if (error.scope === "repository") return new VcsRepoUnavailableError({ message: error.message })
	}
	return new VcsProviderError({
		message: error.message,
		...(error.status === undefined ? {} : { status: error.status }),
		...(error.cause === undefined ? {} : { cause: error.cause }),
	})
}

// Commit fetches fold rate limits into a partial result (see `VcsCommitFetch.next`),
// so a rate-limit error never reaches this path. Narrow the mapper accordingly so
// `fetchCommits` keeps the port's 3-way error channel (no VcsRateLimitedError).
const toVcsCommitError = (
	error: GithubAppError,
): VcsProviderError | VcsInstallationGoneError | VcsRepoUnavailableError => {
	const mapped = toVcsError(error)
	return mapped._tag === "@maple/http/errors/VcsRateLimitedError"
		? new VcsProviderError({ message: mapped.message })
		: mapped
}

const finiteOrNull = (value: number) => (Number.isFinite(value) ? value : null)

// GitHub serves a stable avatar for any login at `<host>/<login>.png`, redirecting
// to that user's current avatar. Derive one from a login so commits whose ingestion
// path carries no avatar URL still resolve to a picture. The host is taken from the
// commit's own html URL (rather than hardcoding github.com) so github.com and GitHub
// Enterprise both stay correct. Returns null when there's no login (no commit author
// linked to a GitHub account) or the base URL can't be parsed — the only cases the
// dashboard renders with an initials fallback.
const githubAvatarUrl = (htmlUrl: string, login: string | null): string | null => {
	if (!login) return null
	try {
		return new URL(`/${encodeURIComponent(login)}.png?size=64`, htmlUrl).href
	} catch {
		return null
	}
}

const installationReason = (action: string): VcsInstallationSyncReason | null => {
	switch (action) {
		case "created":
			return "created"
		case "unsuspend":
			return "unsuspend"
		case "suspend":
			return "suspend"
		case "deleted":
			return "deleted"
		default:
			return null
	}
}

const timingSafeEqual = (a: string, b: string): boolean => {
	const ba = Buffer.from(a)
	const bb = Buffer.from(b)
	if (ba.length !== bb.length) return false
	let mismatch = 0
	for (let i = 0; i < ba.length; i += 1) mismatch |= ba[i]! ^ bb[i]!
	return mismatch === 0
}

const normalizeFetchedCommit = (commit: GithubApiCommit, now: number): CommitUpsertInput => {
	const authoredAt = commit.commit.author?.date ? finiteOrNull(Date.parse(commit.commit.author.date)) : null
	const committedAt = commit.commit.committer?.date
		? finiteOrNull(Date.parse(commit.commit.committer.date))
		: null
	return {
		sha: commit.sha,
		message: commit.commit.message,
		authorName: commit.commit.author?.name ?? null,
		authorEmail: commit.commit.author?.email ?? null,
		authorLogin: commit.author?.login ?? null,
		// REST commits normally carry the user's `avatar_url`; fall back to the
		// login-derived avatar for the (rare) case the field is absent.
		authorAvatarUrl: commit.author?.avatar_url ?? githubAvatarUrl(commit.html_url, commit.author?.login ?? null),
		authoredAt,
		committedAt: committedAt ?? authoredAt ?? now,
		htmlUrl: commit.html_url,
	}
}

export class GithubProvider extends Context.Service<GithubProvider, VcsProviderClient>()(
	"@maple/api/services/vcs/vendor/github/GithubProvider",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const client = yield* GithubAppClient

			// Stamp the (low-cardinality) signature *result* on the active span. NEVER
			// records the signature value or the secret — only the outcome enum. The
			// operator-misconfig case (secret_not_configured) is kept distinct from a
			// genuine attacker `mismatch` so dashboards don't conflate the two.
			const annotateSignatureResult = (result: string) =>
				Effect.annotateCurrentSpan({
					"vcs.webhook.outcome": "rejected",
					"vcs.webhook.signature_result": result,
				})

			const signatureRejected = (result: string, message: string) =>
				Effect.gen(function* () {
					yield* annotateSignatureResult(result)
					return yield* new VcsWebhookSignatureError({ message })
				})

			const verifySignature = (rawBody: string, signatureHeader: string | undefined) =>
				Effect.gen(function* () {
					const secret = env.GITHUB_APP_WEBHOOK_SECRET
					if (Option.isNone(secret)) {
						yield* Effect.logWarning(
							"[GitHub] Webhook secret is not configured (GITHUB_APP_WEBHOOK_SECRET)",
						).pipe(Effect.annotateLogs({ provider: PROVIDER }))
						return yield* signatureRejected(
							"secret_not_configured",
							"GitHub webhook secret is not configured (GITHUB_APP_WEBHOOK_SECRET)",
						)
					}
					if (!signatureHeader) {
						return yield* signatureRejected(
							"missing_header",
							"Missing X-Hub-Signature-256 header",
						)
					}
					if (!signatureHeader.startsWith("sha256=")) {
						return yield* signatureRejected(
							"malformed_header",
							"Malformed X-Hub-Signature-256 header",
						)
					}
					const enc = new TextEncoder()
					const key = yield* Effect.tryPromise({
						try: () =>
							crypto.subtle.importKey(
								"raw",
								enc.encode(Redacted.value(secret.value)),
								{ name: "HMAC", hash: "SHA-256" },
								false,
								["sign"],
							),
						catch: () => "import_failed" as const,
					}).pipe(
						Effect.tapError(annotateSignatureResult),
						Effect.mapError(
							() =>
								new VcsWebhookSignatureError({ message: "Failed to import webhook secret" }),
						),
					)
					const mac = yield* Effect.tryPromise({
						try: () => crypto.subtle.sign("HMAC", key, enc.encode(rawBody)),
						catch: () => "compute_failed" as const,
					}).pipe(
						Effect.tapError(annotateSignatureResult),
						Effect.mapError(
							() =>
								new VcsWebhookSignatureError({
									message: "Failed to compute webhook signature",
								}),
						),
					)
					const expected = `sha256=${Buffer.from(mac).toString("hex")}`
					if (!timingSafeEqual(expected, signatureHeader)) {
						return yield* signatureRejected("mismatch", "Webhook signature mismatch")
					}
					yield* Effect.annotateCurrentSpan({ "vcs.webhook.signature_result": "ok" })
				}).pipe(
					Effect.withSpan("GithubProvider.verifySignature", {
						attributes: { "vcs.provider": PROVIDER },
					}),
				)

			const mapPush = (raw: unknown, now: number) =>
				Effect.gen(function* () {
					const payload = yield* parsePayload("push", decodePush(raw))
					const externalInstallationId = String(payload.installation.id)
					const externalRepoId = String(payload.repository.id)
					yield* Effect.annotateCurrentSpan({
						"vcs.provider.installation_id": externalInstallationId,
						"vcs.repository.external_id": externalRepoId,
						"vcs.push.forced": payload.forced ?? false,
					})
					if (!payload.ref.startsWith("refs/heads/")) {
						// Tag pushes and other non-branch refs aren't synced.
						yield* Effect.annotateCurrentSpan({
							"vcs.webhook.outcome": "skipped",
							"vcs.webhook.skip_reason": "non_branch_ref",
						})
						return []
					}
					const branch = payload.ref.slice("refs/heads/".length)
					yield* Effect.annotateCurrentSpan({ "vcs.push.branch": branch })
					// A force-push rewrote history; the commit payload is unreliable, so don't
					// ship it. Emit a single marker job and let the orchestrator re-walk the
					// branch (if it's one we sync) instead of ingesting the payload. Keeps the
					// rewrite handling in one place and avoids splitting commits we'd discard.
					if (payload.forced) {
						yield* Effect.annotateCurrentSpan({
							"vcs.webhook.outcome": "handled",
							"vcs.webhook.skip_reason": "force_push_marker",
						})
						const job: VcsSyncJob = {
							kind: "push",
							provider: PROVIDER,
							externalInstallationId,
							externalRepoId,
							branch,
							forced: true,
							commits: [],
						}
						return [job]
					}
					const commits: ReadonlyArray<CommitUpsertInput> = (payload.commits ?? []).map((c) => {
						const ts = c.timestamp ? finiteOrNull(Date.parse(c.timestamp)) : null
						return {
							sha: c.id,
							message: c.message,
							authorName: c.author?.name ?? null,
							authorEmail: c.author?.email ?? null,
							authorLogin: c.author?.username ?? null,
							// Push payloads carry only a committer username — no avatar URL —
							// so derive one from the login (see githubAvatarUrl) instead of
							// leaving it null and patching it up in the dashboard.
							authorAvatarUrl: githubAvatarUrl(c.url, c.author?.username ?? null),
							authoredAt: ts,
							committedAt: ts ?? now,
							htmlUrl: c.url,
						}
					})
					yield* Effect.annotateCurrentSpan({ "vcs.push.commit_count": commits.length })
					if (commits.length === 0) {
						yield* Effect.annotateCurrentSpan({
							"vcs.webhook.outcome": "skipped",
							"vcs.webhook.skip_reason": "no_commits",
						})
						return []
					}
					// A push is best-effort enrichment only — the per-branch commit backfill
					// remains the authoritative source for a repo's commit history.
					const makeJob = (slice: ReadonlyArray<CommitUpsertInput>): VcsSyncJob => ({
						kind: "push",
						provider: PROVIDER,
						externalInstallationId,
						externalRepoId,
						branch,
						commits: slice,
					})
					// Greedily pack commits into jobs that each stay under the queue cap.
					// `JSON.stringify` byte length is a conservative proxy for the wire size
					// (CommitUpsertInput encodes 1:1, and the queue's v8 serialization is no
					// larger for this string-heavy shape). Each commit is always placed in a
					// job (guaranteed progress), so a lone commit bigger than the budget — a
					// pathologically huge message, which the branch's commit backfill re-fetches
					// in full anyway — gets its own job rather than stalling the loop.
					const envelopeBytes = Buffer.byteLength(JSON.stringify(makeJob([])))
					const jobs: VcsSyncJob[] = []
					let slice: CommitUpsertInput[] = []
					let sliceBytes = envelopeBytes
					for (const c of commits) {
						const commitBytes = Buffer.byteLength(JSON.stringify(c)) + 1 // +1: array comma
						if (slice.length > 0 && sliceBytes + commitBytes > PUSH_JOB_MAX_BYTES) {
							jobs.push(makeJob(slice))
							slice = []
							sliceBytes = envelopeBytes
						}
						slice.push(c)
						sliceBytes += commitBytes
					}
					jobs.push(makeJob(slice))
					yield* Effect.annotateCurrentSpan({
						"vcs.webhook.outcome": "handled",
						"vcs.webhook.jobs": jobs.length,
					})
					return jobs
				})

			const mapInstallationEvent =
				(event: string, reasonFor: (action: string) => VcsInstallationSyncReason | null) =>
				(raw: unknown) =>
					Effect.gen(function* () {
						const payload = yield* parsePayload(event, decodeInstallationEvent(raw))
						const externalInstallationId = String(payload.installation.id)
						yield* Effect.annotateCurrentSpan({
							"vcs.webhook.action": payload.action,
							"vcs.provider.installation_id": externalInstallationId,
						})
						const reason = reasonFor(payload.action)
						if (!reason) {
							yield* Effect.annotateCurrentSpan({
								"vcs.webhook.outcome": "skipped",
								"vcs.webhook.skip_reason": "unhandled_action",
							})
							return []
						}
						yield* Effect.annotateCurrentSpan({ "vcs.webhook.outcome": "handled" })
						const job: VcsSyncJob = {
							kind: "installation-sync",
							provider: PROVIDER,
							externalInstallationId,
							reason,
						}
						return [job]
					})

			const mapInstallation = mapInstallationEvent("installation", installationReason)
			const mapInstallationRepositories = mapInstallationEvent("installation_repositories", (action) =>
				action === "added"
					? "repositories_added"
					: action === "removed"
						? "repositories_removed"
						: null,
			)

			// `create`/`delete` (ref_type=branch) → one branch-event job; tags are ignored.
			// The branch table mutates directly in the orchestrator (no GitHub call).
			const mapRefEvent = (action: "created" | "deleted") => (raw: unknown) =>
				Effect.gen(function* () {
					const payload = yield* parsePayload(
						action === "created" ? "create" : "delete",
						decodeRefEvent(raw),
					)
					const externalInstallationId = String(payload.installation.id)
					const externalRepoId = String(payload.repository.id)
					yield* Effect.annotateCurrentSpan({
						"vcs.provider.installation_id": externalInstallationId,
						"vcs.repository.external_id": externalRepoId,
					})
					if (payload.ref_type !== "branch") {
						yield* Effect.annotateCurrentSpan({
							"vcs.webhook.outcome": "skipped",
							"vcs.webhook.skip_reason": "non_branch_ref_event",
						})
						return []
					}
					yield* Effect.annotateCurrentSpan({
						"vcs.webhook.outcome": "handled",
						"vcs.push.branch": payload.ref,
					})
					const job: VcsSyncJob = {
						kind: "branch-event",
						provider: PROVIDER,
						externalInstallationId,
						externalRepoId,
						action,
						branch: payload.ref,
					}
					return [job]
				})

			// Dispatch a verified, parsed event to its mapper. Annotations (outcome /
			// skip_reason / identifiers) are made by each mapper onto the surrounding
			// `webhookToJobs` span.
			const mapEvent = (event: string | undefined, parsed: unknown, now: number) =>
				Effect.gen(function* () {
					return yield* Match.value(event).pipe(
						Match.when("push", () => mapPush(parsed, now)),
						Match.when("installation", () => mapInstallation(parsed)),
						Match.when("installation_repositories", () =>
							mapInstallationRepositories(parsed),
						),
						Match.when("create", () => mapRefEvent("created")(parsed)),
						Match.when("delete", () => mapRefEvent("deleted")(parsed)),
						Match.orElse(() =>
							// ping and unhandled events are accepted no-ops.
							Effect.annotateCurrentSpan({
								"vcs.webhook.outcome": "skipped",
								"vcs.webhook.skip_reason": "unhandled_event",
							}).pipe(Effect.as([])),
						),
					)
				})

			const webhookToJobs = (input: VcsWebhookRequest) =>
				Effect.gen(function* () {
					yield* verifySignature(input.rawBody, input.headers["x-hub-signature-256"])
					const parsed = yield* Effect.try({
						try: () => JSON.parse(input.rawBody) as unknown,
						catch: () => parseError("Invalid JSON body"),
					}).pipe(
						Effect.tapError(() =>
							Effect.annotateCurrentSpan({
								"vcs.webhook.outcome": "rejected",
								"vcs.webhook.parse_error": "invalid_json",
							}),
						),
					)
					const now = yield* Clock.currentTimeMillis
					const jobs = yield* mapEvent(input.headers["x-github-event"], parsed, now)
					// Stamp the GitHub delivery id onto every job this webhook produced, so
					// the queue consumer's processMessage span can be correlated back to this
					// webhook's receive span (both carry `vcs.webhook.delivery_id`). Every
					// webhook-origin job kind (installation-sync / push / branch-event) carries
					// the optional field; Schema strips it from any kind that doesn't.
					const deliveryId = input.headers["x-github-delivery"]
					return deliveryId ? jobs.map((job) => ({ ...job, deliveryId })) : jobs
				}).pipe(
					Effect.withSpan("GithubProvider.webhookToJobs", {
						attributes: {
							"vcs.provider": PROVIDER,
							"vcs.webhook.event": input.headers["x-github-event"] ?? "unknown",
						},
					}),
				)

			const fetchRepositories = (installation: VcsInstallation) =>
				client.listInstallationRepositories(installation.externalInstallationId).pipe(
					Effect.map(
						(repos): ReadonlyArray<RepoUpsertInput> =>
							repos.map((r) => ({
								externalRepoId: String(r.id),
								owner: r.owner.login,
								name: r.name,
								fullName: r.full_name,
								defaultBranch: r.default_branch ?? "main",
								htmlUrl: r.html_url,
								isPrivate: r.private,
								isArchived: r.archived ?? false,
							})),
					),
					Effect.mapError(toVcsError),
				)

			const fetchCommits = (
				installation: VcsInstallation,
				repo: VcsRepositoryRef,
				opts: { readonly sinceMs: number; readonly untilMs?: number; readonly branch: string },
			) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					// GitHub's `since`/`until` filter by *committer* date (matching the
					// port's "committed since" contract) — a GitHub specific that stays here.
					const result = yield* client
						.listCommits(installation.externalInstallationId, repo.owner, repo.name, {
							sha: opts.branch,
							sinceIso: new Date(opts.sinceMs).toISOString(),
							...(opts.untilMs === undefined
								? {}
								: { untilIso: new Date(opts.untilMs).toISOString() }),
						})
						.pipe(Effect.mapError(toVcsCommitError))
					const normalized = result.commits.map((c) => normalizeFetchedCommit(c, now))
					if (result.complete) return { commits: normalized }
					// Cut short mid-walk (throttled, or at the per-invocation page budget):
					// resume from the oldest committer-date we got (a stable watermark —
					// re-fetching only the boundary, idempotently). A page-budget stop
					// continues immediately (no wait); a rate limit waits out its reset.
					// SAFE ONLY because GitHub's listing is newest-first, so a truncated
					// page is the descending-committer-date prefix of the window — `Math.min`
					// is order-agnostic, but the *coverage* of the truncated page is not.
					// See the ordering contract on `VcsProviderClient.fetchCommits`.
					const oldestMs =
						normalized.length > 0
							? normalized.reduce(
									(min, c) => Math.min(min, c.committedAt),
									Number.POSITIVE_INFINITY,
								)
							: (opts.untilMs ?? now)
					return {
						commits: normalized,
						next: {
							untilMs: oldestMs,
							reason: result.reason,
							retryAfterSeconds:
								result.reason === "rate-limited" ? result.retryAfterSeconds : 0,
						},
					}
				})

			const fetchCommit = (installation: VcsInstallation, repo: VcsRepositoryRef, sha: GitCommitSha) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					return yield* client
						.getCommit(installation.externalInstallationId, repo.owner, repo.name, sha)
						.pipe(
							Effect.map((commit) => Option.some(normalizeFetchedCommit(commit, now))),
							// A 404 means this repo doesn't contain the SHA (or access was lost) —
							// for a SHA-only probe that's "look in the next repo", not a failure.
							// Every other GitHub failure is mapped to the port's semantic errors.
							Effect.catchTag("GithubAppError", (error) =>
								error.status === 404
									? Effect.succeed(Option.none<CommitUpsertInput>())
									: Effect.fail(toVcsCommitError(error)),
							),
						)
				})

			const fetchBranches = (installation: VcsInstallation, repo: VcsRepositoryRef) =>
				client.listBranches(installation.externalInstallationId, repo.owner, repo.name).pipe(
					Effect.map(
						(result): { branches: ReadonlyArray<BranchUpsertInput>; truncated: boolean } => ({
							// Names + head only — which branch is "default" is the repo layer's
							// concern (a display hint it derives from the repo's defaultBranch).
							branches: result.branches.map((b) => ({
								name: b.name,
								headSha: b.commit.sha,
							})),
							truncated: result.truncated,
						}),
					),
					Effect.mapError(toVcsError),
				)

			return {
				id: PROVIDER,
				webhookToJobs,
				fetchRepositories,
				fetchCommits,
				fetchBranches,
				fetchCommit,
			} satisfies VcsProviderClient
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
