import { Schema, SchemaGetter } from "effect"
import { OrgId, UserId } from "../primitives"

// Vendor-agnostic VCS integration types.
//
// Everything here is provider-neutral: rows carry a `provider` discriminator
// and GitHub-specific concepts (App auth, REST/webhook payload shapes) live in
// the GitHub layer behind the `VcsProviderClient` port. Adding another provider
// means extending `VcsProviderId` + the enum normalizations — no new tables.

export const VcsInstallationId = Schema.String.check(Schema.isUUID()).pipe(
	Schema.brand("@maple/VcsInstallationId"),
	Schema.annotate({ identifier: "@maple/VcsInstallationId", title: "VCS Installation ID" }),
)
export type VcsInstallationId = Schema.Schema.Type<typeof VcsInstallationId>

export const VcsRepositoryId = Schema.String.check(Schema.isUUID()).pipe(
	Schema.brand("@maple/VcsRepositoryId"),
	Schema.annotate({ identifier: "@maple/VcsRepositoryId", title: "VCS Repository ID" }),
)
export type VcsRepositoryId = Schema.Schema.Type<typeof VcsRepositoryId>

export const VcsCommitRowId = Schema.String.check(Schema.isUUID()).pipe(
	Schema.brand("@maple/VcsCommitRowId"),
	Schema.annotate({ identifier: "@maple/VcsCommitRowId", title: "VCS Commit Row ID" }),
)
export type VcsCommitRowId = Schema.Schema.Type<typeof VcsCommitRowId>

export const VcsBranchId = Schema.String.check(Schema.isUUID()).pipe(
	Schema.brand("@maple/VcsBranchId"),
	Schema.annotate({ identifier: "@maple/VcsBranchId", title: "VCS Branch ID" }),
)
export type VcsBranchId = Schema.Schema.Type<typeof VcsBranchId>

/**
 * A full 40-char git commit SHA. Case-insensitive on input and normalized to
 * lowercase during decode, so the same commit is identified regardless of the
 * case a provider — or an OTel `deployment.commit_sha` attribute — emits it in.
 * Strict — unlike the permissive telemetry `CommitSha` brand (which must not
 * throw on arbitrary OTel data) — so the SHA-shape regex lives in exactly this
 * one declarative type, validated at the webhook/REST boundary and on persistence.
 *
 * (40 hex = git's SHA-1 object format; git's experimental SHA-256 object format
 * — 64 hex — is a known, currently-unused limitation across every git host.)
 */
const GitCommitShaBrand = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)).pipe(
	Schema.brand("@maple/GitCommitSha"),
)
export const GitCommitSha = Schema.String.pipe(
	// Lowercase before the pattern check so `aBc…` and `ABC…` resolve to the same branded value.
	Schema.decodeTo(GitCommitShaBrand, {
		decode: SchemaGetter.transform((s: string) => s.toLowerCase()),
		encode: SchemaGetter.passthrough<string>(),
	}),
	Schema.annotate({ identifier: "@maple/GitCommitSha", title: "Git Commit SHA" }),
)
export type GitCommitSha = Schema.Schema.Type<typeof GitCommitSha>

/** The set of supported VCS providers. Extend this array to add a provider. */
export const VcsProviderId = Schema.Literals(["github"]).annotate({
	identifier: "@maple/VcsProviderId",
	title: "VCS Provider",
})
export type VcsProviderId = Schema.Schema.Type<typeof VcsProviderId>

export const VcsAccountType = Schema.Literals(["organization", "user"]).annotate({
	identifier: "@maple/VcsAccountType",
	title: "VCS Account Type",
})
export type VcsAccountType = Schema.Schema.Type<typeof VcsAccountType>

export const VcsInstallStatus = Schema.Literals(["active", "suspended", "disconnected"]).annotate({
	identifier: "@maple/VcsInstallStatus",
	title: "VCS Installation Status",
})
export type VcsInstallStatus = Schema.Schema.Type<typeof VcsInstallStatus>

export const VcsRepoSelection = Schema.Literals(["all", "selected"]).annotate({
	identifier: "@maple/VcsRepoSelection",
	title: "VCS Repository Selection",
})
export type VcsRepoSelection = Schema.Schema.Type<typeof VcsRepoSelection>

export const VcsRepoSyncStatus = Schema.Literals(["pending", "backfilling", "ready", "error"]).annotate({
	identifier: "@maple/VcsRepoSyncStatus",
	title: "VCS Repository Sync Status",
})
export type VcsRepoSyncStatus = Schema.Schema.Type<typeof VcsRepoSyncStatus>

/**
 * A repository's lifecycle (access) state — orthogonal to its `syncStatus`.
 * `active`: the installation can currently see the repo. `removed`: the provider
 * revoked access (a GitHub `installation_repositories` removed event), so the
 * repo is soft-deleted — its row and synced commits are kept, but no further
 * events are processed for it until access is re-granted (which flips it back to
 * `active`). A hard delete is user-initiated only.
 */
export const VcsRepoStatus = Schema.Literals(["active", "removed"]).annotate({
	identifier: "@maple/VcsRepoStatus",
	title: "VCS Repository Status",
})
export type VcsRepoStatus = Schema.Schema.Type<typeof VcsRepoStatus>

export class VcsInstallation extends Schema.Class<VcsInstallation>("VcsInstallation")({
	id: VcsInstallationId,
	orgId: OrgId,
	provider: VcsProviderId,
	externalInstallationId: Schema.String,
	accountLogin: Schema.String,
	accountType: VcsAccountType,
	externalAccountId: Schema.String,
	accountAvatarUrl: Schema.NullOr(Schema.String),
	repositorySelection: VcsRepoSelection,
	status: VcsInstallStatus,
	suspendedAt: Schema.NullOr(Schema.Number),
	installedByUserId: UserId,
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
}) {}

/**
 * The single, vendor-agnostic answer to "should the sync engine act on this
 * installation's data?". Only `active` installations are processed — `suspended`
 * (provider temporarily disabled it) and `disconnected` (uninstalled / access
 * revoked) are both skipped. Every data-processing path gates on this so the
 * rule lives in exactly one place.
 */
export const isInstallationProcessable = (installation: VcsInstallation): boolean =>
	installation.status === "active"

export class VcsRepo extends Schema.Class<VcsRepo>("VcsRepo")({
	id: VcsRepositoryId,
	orgId: OrgId,
	provider: VcsProviderId,
	/** The owning installation, by Maple's internal id (resolved from the external id). */
	installationId: VcsInstallationId,
	externalRepoId: Schema.String,
	owner: Schema.String,
	name: Schema.String,
	fullName: Schema.String,
	defaultBranch: Schema.String,
	/**
	 * The single branch this repo tracks — only its commits are backfilled and
	 * ingested. Seeded to `defaultBranch` on discovery and user-owned thereafter.
	 * Null only for a legacy row whose tracked branch was never set; the sync
	 * engine treats null as "fall back to `defaultBranch`".
	 */
	trackedBranch: Schema.NullOr(Schema.String),
	htmlUrl: Schema.String,
	isPrivate: Schema.Boolean,
	isArchived: Schema.Boolean,
	status: VcsRepoStatus,
	syncStatus: VcsRepoSyncStatus,
	lastSyncedAt: Schema.NullOr(Schema.Number),
	lastSyncError: Schema.NullOr(Schema.String),
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
}) {}

export class VcsCommit extends Schema.Class<VcsCommit>("VcsCommit")({
	id: VcsCommitRowId,
	orgId: OrgId,
	provider: VcsProviderId,
	/** The owning `vcs_repositories` row — a commit always belongs to one repo. */
	repositoryId: VcsRepositoryId,
	sha: GitCommitSha,
	message: Schema.String,
	authorName: Schema.NullOr(Schema.String),
	authorEmail: Schema.NullOr(Schema.String),
	authorLogin: Schema.NullOr(Schema.String),
	authorAvatarUrl: Schema.NullOr(Schema.String),
	authoredAt: Schema.NullOr(Schema.Number),
	committedAt: Schema.Number,
	htmlUrl: Schema.String,
	createdAt: Schema.Number,
}) {}

/**
 * A branch of a repository — just its identity (name + head). The list of these
 * rows is the dashboard's picker of branches the user can choose to track; which
 * one is actually tracked is named by `VcsRepo.trackedBranch`, not a flag here.
 * `isDefault` is a display hint and the seed for a repo's initial tracked branch.
 */
export class VcsBranch extends Schema.Class<VcsBranch>("VcsBranch")({
	id: VcsBranchId,
	orgId: OrgId,
	provider: VcsProviderId,
	/** The owning `vcs_repositories` row — a branch always belongs to one repo. */
	repositoryId: VcsRepositoryId,
	name: Schema.String,
	isDefault: Schema.Boolean,
	headSha: Schema.NullOr(GitCommitSha),
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
}) {}

/** Normalized repository, returned by a provider and persisted by the repo. */
export const RepoUpsertInput = Schema.Struct({
	externalRepoId: Schema.String,
	owner: Schema.String,
	name: Schema.String,
	fullName: Schema.String,
	defaultBranch: Schema.String,
	htmlUrl: Schema.String,
	isPrivate: Schema.Boolean,
	isArchived: Schema.Boolean,
})
export type RepoUpsertInput = Schema.Schema.Type<typeof RepoUpsertInput>

/** Normalized commit, returned by a provider (or extracted from a push). */
export const CommitUpsertInput = Schema.Struct({
	sha: Schema.String,
	message: Schema.String,
	authorName: Schema.NullOr(Schema.String),
	authorEmail: Schema.NullOr(Schema.String),
	authorLogin: Schema.NullOr(Schema.String),
	authorAvatarUrl: Schema.NullOr(Schema.String),
	authoredAt: Schema.NullOr(Schema.Number),
	committedAt: Schema.Number,
	htmlUrl: Schema.String,
})
export type CommitUpsertInput = Schema.Schema.Type<typeof CommitUpsertInput>

/**
 * Normalized branch, returned by a provider's fetchBranches. Names + head only —
 * the provider is oblivious to which branch is the default; the repo layer derives
 * the `isDefault` display hint by comparing against the repo's `defaultBranch`.
 */
export const BranchUpsertInput = Schema.Struct({
	name: Schema.String,
	headSha: Schema.NullOr(Schema.String),
})
export type BranchUpsertInput = Schema.Schema.Type<typeof BranchUpsertInput>

/**
 * Result of a provider commit fetch: the normalized commits, plus an optional
 * resume cursor. The branch head is deliberately NOT reported — incremental sync
 * derives its watermark from `max(committed_at)` of the persisted commits, so no
 * provider has to claim a head and no caller infers one from array position.
 *
 * `next` is present iff the walk was cut short before the requested window was
 * fully fetched, for one of two reasons:
 *  - `"rate-limited"`: the provider throttled us — resume after `retryAfterSeconds`.
 *  - `"page-budget"`: the provider voluntarily yielded after a bounded number of
 *    pages, to keep a single consumer invocation's wall-clock under the queue's
 *    limit — resume immediately (`retryAfterSeconds` is 0).
 * Either way, resume the backfill from `untilMs` (a committer-date watermark).
 * Absent ⇒ the window is complete.
 *
 * `untilMs` is `min(committedAt)` of the commits in this page, and the caller
 * resumes strictly *below* it — which is only correct if a truncated page is the
 * descending-committer-date prefix of the requested window (newest-first, no gap).
 * A provider that truncates out of order would advance the watermark past commits
 * it never returned, silently skipping them. See `VcsProviderClient.fetchCommits`
 * for the full ordering contract a provider must honour.
 */
export interface VcsCommitFetch {
	readonly commits: ReadonlyArray<CommitUpsertInput>
	readonly next?: {
		readonly untilMs: number
		readonly retryAfterSeconds: number
		readonly reason: "rate-limited" | "page-budget"
	}
}

/** Minimal repo identity a provider needs to fetch commits or branches. */
export const VcsRepositoryRef = Schema.Struct({
	externalRepoId: Schema.String,
	owner: Schema.String,
	name: Schema.String,
})
export type VcsRepositoryRef = Schema.Schema.Type<typeof VcsRepositoryRef>

export const VcsInstallationSyncReason = Schema.Literals([
	"created",
	"updated",
	"unsuspend",
	"repositories_added",
	"repositories_removed",
	"suspend",
	"deleted",
	// A periodic (cron) reconcile: re-list repos (reconciling both additions and
	// removals), refresh each repo's branches, and backfill each tracked branch —
	// the backstop for webhook deliveries that were missed. Carries no status
	// transition and no sibling purge; it is a pure data refresh.
	"scheduled",
]).annotate({ identifier: "@maple/VcsInstallationSyncReason", title: "VCS Installation Sync Reason" })
export type VcsInstallationSyncReason = Schema.Schema.Type<typeof VcsInstallationSyncReason>

// Jobs carry only `externalInstallationId` (+ provider); the sync orchestrator resolves `orgId`
// from the installation row (a webhook handler has no DB access and cannot know the Maple org).
export const InstallationSyncJob = Schema.Struct({
	kind: Schema.Literal("installation-sync"),
	provider: VcsProviderId,
	externalInstallationId: Schema.String,
	reason: VcsInstallationSyncReason,
	deliveryId: Schema.optionalKey(Schema.String),
})
export type InstallationSyncJob = Schema.Schema.Type<typeof InstallationSyncJob>

// Walk the repo's tracked branch over a window, upserting each commit found onto
// the repo (commits belong to the repo, not a branch). Enqueued for the single
// tracked branch by the sync-branches handler, on a tracked-branch change (after
// the repo's commits are wiped), and as a reconciling re-walk after a force-push.
// A walk cut short by a rate limit / page budget resumes via `untilMs`.
export const SyncCommitsJob = Schema.Struct({
	kind: Schema.Literal("sync-commits"),
	provider: VcsProviderId,
	externalInstallationId: Schema.String,
	externalRepoId: Schema.String,
	owner: Schema.String,
	name: Schema.String,
	// The ref to walk — all commits fetched are stored against this branch.
	branch: Schema.String,
	sinceMs: Schema.Number,
	// Resume cursor for a continuation requeued after a rate limit: fetch commits
	// committed at-or-before `untilMs` (a committer-date watermark). Absent on a
	// fresh walk.
	untilMs: Schema.optionalKey(Schema.Number),
	// Count of consecutive continuations that fetched zero commits (rate-limited
	// before any progress). Reset to 0 whenever a run makes progress; bounded so a
	// permanently throttled installation can't requeue forever. Absent ⇒ 0.
	staleAttempts: Schema.optionalKey(Schema.Number),
})
export type SyncCommitsJob = Schema.Schema.Type<typeof SyncCommitsJob>

// A push event's commits, applied incrementally — purely best-effort enrichment.
// GitHub caps `commits` at 2048 per delivery and never splits a push across
// deliveries, so this is never treated as authoritative: the commit backfill
// re-fetches the full branch history regardless.
export const PushJob = Schema.Struct({
	kind: Schema.Literal("push"),
	provider: VcsProviderId,
	externalInstallationId: Schema.String,
	externalRepoId: Schema.String,
	branch: Schema.String,
	// GitHub `forced: true` ⇒ a force-push (rebase / history rewrite). Triggers a
	// reconciling backfill of the branch so stale commit membership is pruned.
	forced: Schema.optionalKey(Schema.Boolean),
	commits: Schema.Array(CommitUpsertInput),
	deliveryId: Schema.optionalKey(Schema.String),
})
export type PushJob = Schema.Schema.Type<typeof PushJob>

// List + reconcile a repo's branches (names only — never the commits on them).
// Enqueued per repo by an installation-sync; re-lists from the provider, prunes
// vanished branches (falling back to the default if the tracked one vanished),
// and re-enqueues a backfill of the repo's single tracked branch.
export const SyncBranchesJob = Schema.Struct({
	kind: Schema.Literal("sync-branches"),
	provider: VcsProviderId,
	externalInstallationId: Schema.String,
	externalRepoId: Schema.String,
	owner: Schema.String,
	name: Schema.String,
})
export type SyncBranchesJob = Schema.Schema.Type<typeof SyncBranchesJob>

// A branch create/delete webhook (`create`/`delete`, ref_type=branch). Mutates
// the branch table directly — no provider call. Deleting the repo's tracked
// branch falls it back to the default (wipe + resync); other deletions just drop
// the branch row (its commits stay — they may be referenced by past telemetry).
export const BranchEventJob = Schema.Struct({
	kind: Schema.Literal("branch-event"),
	provider: VcsProviderId,
	externalInstallationId: Schema.String,
	externalRepoId: Schema.String,
	action: Schema.Literals(["created", "deleted"]),
	branch: Schema.String,
	deliveryId: Schema.optionalKey(Schema.String),
})
export type BranchEventJob = Schema.Schema.Type<typeof BranchEventJob>

export const VcsSyncJob = Schema.Union([
	InstallationSyncJob,
	SyncCommitsJob,
	PushJob,
	SyncBranchesJob,
	BranchEventJob,
])
export type VcsSyncJob = Schema.Schema.Type<typeof VcsSyncJob>

export class VcsRepoPersistenceError extends Schema.TaggedError<VcsRepoPersistenceError>()(
	"@maple/http/errors/VcsRepoPersistenceError",
	{ message: Schema.String },
	{ httpApiStatus: 503 },
) {}

export class VcsRepoDecodeError extends Schema.TaggedError<VcsRepoDecodeError>()(
	"@maple/http/errors/VcsRepoDecodeError",
	{ message: Schema.String, table: Schema.String, column: Schema.optionalKey(Schema.String) },
	{ httpApiStatus: 500 },
) {}

export class VcsQueueError extends Schema.TaggedError<VcsQueueError>()(
	"@maple/http/errors/VcsQueueError",
	{ message: Schema.String },
	{ httpApiStatus: 503 },
) {}

export class VcsProviderError extends Schema.TaggedError<VcsProviderError>()(
	"@maple/http/errors/VcsProviderError",
	{
		message: Schema.String,
		status: Schema.optionalKey(Schema.Number),
		cause: Schema.optionalKey(Schema.Defect()),
	},
	{ httpApiStatus: 502 },
) {}

/**
 * The provider is certain the installation no longer exists / access is
 * permanently revoked at the installation level (e.g. GitHub's installation
 * token endpoint returning 410 Gone). The ONLY error the sync orchestrator treats
 * as a disconnect — raw HTTP status never drives that decision. Providers must
 * only raise this when the signal is unambiguous.
 */
export class VcsInstallationGoneError extends Schema.TaggedError<VcsInstallationGoneError>()(
	"@maple/http/errors/VcsInstallationGoneError",
	{ message: Schema.String },
	{ httpApiStatus: 410 },
) {}

/**
 * The provider is certain a specific repository is permanently inaccessible
 * (deleted / renamed / access lost). Scoped to the repo — never the installation.
 */
export class VcsRepoUnavailableError extends Schema.TaggedError<VcsRepoUnavailableError>()(
	"@maple/http/errors/VcsRepoUnavailableError",
	{ message: Schema.String },
	{ httpApiStatus: 404 },
) {}

/**
 * A provider rate limit too far out to wait inline. `retryAfterSeconds` is seconds
 * until the budget resets (from `retry-after` / rate-limit headers). The sync
 * consumer redelivers the failed job with this delay; backfill catches it earlier
 * and requeues from a cursor (see `VcsCommitFetch.next`).
 */
export class VcsRateLimitedError extends Schema.TaggedError<VcsRateLimitedError>()(
	"@maple/http/errors/VcsRateLimitedError",
	{ message: Schema.String, retryAfterSeconds: Schema.Number },
	{ httpApiStatus: 429 },
) {}

export class VcsWebhookSignatureError extends Schema.TaggedError<VcsWebhookSignatureError>()(
	"@maple/http/errors/VcsWebhookSignatureError",
	{ message: Schema.String },
	{ httpApiStatus: 401 },
) {}

export class VcsWebhookParseError extends Schema.TaggedError<VcsWebhookParseError>()(
	"@maple/http/errors/VcsWebhookParseError",
	{ message: Schema.String },
	{ httpApiStatus: 400 },
) {}

export class UnknownVcsProviderError extends Schema.TaggedError<UnknownVcsProviderError>()(
	"@maple/http/errors/UnknownVcsProviderError",
	{ provider: Schema.String, message: Schema.String },
	{ httpApiStatus: 404 },
) {}

/**
 * The requested commit reference is not a resolvable git SHA — it failed the
 * strict 40-hex `GitCommitSha` shape. Telemetry `deployment.commit_sha` is
 * unguarded OTel data, so a value can be a short SHA, a tag, or arbitrary text;
 * the hover-card endpoint surfaces that as this distinct, non-retryable error
 * (422) rather than a generic 400, so the dashboard can render a muted
 * "non-standard commit reference" state instead of a failure.
 */
export class VcsCommitShaInvalidError extends Schema.TaggedError<VcsCommitShaInvalidError>()(
	"@maple/http/errors/VcsCommitShaInvalidError",
	{ message: Schema.String, sha: Schema.String },
	{ httpApiStatus: 422 },
) {}

/**
 * The SHA is a valid 40-hex commit, but no connected repository in the org
 * contains it (neither stored nor resolvable on the fly from any provider).
 */
export class VcsCommitNotFoundError extends Schema.TaggedError<VcsCommitNotFoundError>()(
	"@maple/http/errors/VcsCommitNotFoundError",
	{ message: Schema.String, sha: Schema.String },
	{ httpApiStatus: 404 },
) {}

export class OAuthStatePersistenceError extends Schema.TaggedError<OAuthStatePersistenceError>()(
	"@maple/http/errors/OAuthStatePersistenceError",
	{ message: Schema.String },
	{ httpApiStatus: 503 },
) {}
