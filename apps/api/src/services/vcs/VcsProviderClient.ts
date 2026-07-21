import type { Effect, Option } from "effect"
import type {
	BranchUpsertInput,
	CommitUpsertInput,
	GitCommitSha,
	RepoUpsertInput,
	VcsCommitFetch,
	VcsInstallation,
	VcsInstallationGoneError,
	VcsProviderError,
	VcsProviderId,
	VcsRateLimitedError,
	VcsRepositoryRef,
	VcsRepoUnavailableError,
	VcsSyncJob,
	VcsWebhookParseError,
	VcsWebhookSignatureError,
} from "@maple/domain/http"

// ---------------------------------------------------------------------------
// The single typed seam between the vendor-agnostic core and a VCS provider.
//
// Everything ABOVE this port (queue, orchestrator, webhook router, repo, tables)
// is provider-neutral and never imports a provider module. Everything BELOW it
// (GithubProvider, GithubAppClient, GitHub schemas) is provider-specific and
// never imports the vcs_* tables. The registry is the only place a provider id
// is wired to an implementation.
// ---------------------------------------------------------------------------

export interface VcsWebhookRequest {
	readonly headers: Record<string, string | undefined>
	readonly rawBody: string
}

/** A provider-neutral code-search hit returned to the investigation layer. */
export interface VcsCodeSearchMatch {
	readonly path: string
	readonly sha: string
	readonly htmlUrl: string
	readonly snippets: ReadonlyArray<string>
}

/** A text source file fetched from a repository at an explicit ref. */
export interface VcsSourceFile {
	readonly path: string
	readonly sha: string
	readonly htmlUrl: string
	readonly size: number
	readonly content: string
}

export interface VcsProviderClient {
	readonly id: VcsProviderId

	/** Verify the webhook signature, parse the event, and map it to generic jobs. */
	readonly webhookToJobs: (
		input: VcsWebhookRequest,
	) => Effect.Effect<ReadonlyArray<VcsSyncJob>, VcsWebhookSignatureError | VcsWebhookParseError>

	/**
	 * All repositories visible to an installation, normalized. A rate limit too far
	 * out to ride inline surfaces as `VcsRateLimitedError` (the caller redelivers the
	 * whole job after the delay — repo lists are small, so refetch is cheap).
	 */
	readonly fetchRepositories: (
		installation: VcsInstallation,
	) => Effect.Effect<
		ReadonlyArray<RepoUpsertInput>,
		VcsProviderError | VcsInstallationGoneError | VcsRepoUnavailableError | VcsRateLimitedError
	>

	/**
	 * Commits on `branch` *committed* in `(sinceMs, untilMs]`, normalized. `branch`
	 * is always explicit — no implicit default-branch fallback. `untilMs` resumes a
	 * rate-limited backfill from a watermark; omit it for a fresh walk from the tip.
	 *
	 * Being cut short is NOT an error: on a rate limit, OR after a bounded number of
	 * pages (so one invocation's wall-clock stays under the queue limit), the provider
	 * returns what it fetched plus `VcsCommitFetch.next` (resume cursor + delay +
	 * reason). Failures: `VcsInstallationGoneError` (disconnect),
	 * `VcsRepoUnavailableError` (repo-scoped), `VcsProviderError` (transient).
	 *
	 * ORDERING CONTRACT (load-bearing — read before implementing a new provider):
	 * when the walk is cut short, the returned commits MUST be the descending-
	 * committer-date *prefix* of the requested `(sinceMs, untilMs]` window — i.e. the
	 * provider must walk the window newest-first, and a truncated page must contain
	 * the newest commits in the window, contiguously, with no gap. The resume
	 * watermark is `min(committedAt)` of the page, so the caller assumes everything
	 * from that watermark up to `untilMs` is fully fetched and resumes *below* it.
	 * A provider that truncates a page out of committer-date order (oldest-first or
	 * arbitrary) would push the watermark down past commits it never returned, and
	 * those commits are then silently skipped forever — a coverage gap, not a crash.
	 * (An *untruncated* page — `next` absent — may be in any order; the requirement
	 * only bites on truncation.) GitHub satisfies this because its commits listing is
	 * newest-first; any new provider must guarantee the same.
	 */
	readonly fetchCommits: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		opts: { readonly sinceMs: number; readonly untilMs?: number; readonly branch: string },
	) => Effect.Effect<VcsCommitFetch, VcsProviderError | VcsInstallationGoneError | VcsRepoUnavailableError>

	/**
	 * All branch names of a repo (never the commits on them), normalized. `truncated`
	 * is true when the provider's listing hit its page cap — the caller then skips
	 * delete-reconciliation (absence isn't authoritative). A rate limit too far out
	 * surfaces as `VcsRateLimitedError` (the caller redelivers; branch lists are small).
	 */
	readonly fetchBranches: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
	) => Effect.Effect<
		{ readonly branches: ReadonlyArray<BranchUpsertInput>; readonly truncated: boolean },
		VcsProviderError | VcsInstallationGoneError | VcsRepoUnavailableError | VcsRateLimitedError
	>

	/**
	 * Resolve a single commit by SHA within one repo, normalized. `Option.none`
	 * means "not found in this repo" (404 — expected, not a failure); errors
	 * signal genuine provider/installation failures so callers can distinguish
	 * "keep looking" from "the provider is down".
	 */
	readonly fetchCommit: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		sha: GitCommitSha,
	) => Effect.Effect<
		Option.Option<CommitUpsertInput>,
		VcsProviderError | VcsInstallationGoneError | VcsRepoUnavailableError
	>

	/** Search source within one repository visible to this installation. */
	readonly searchCode: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		query: string,
		opts: { readonly path?: string; readonly limit: number },
	) => Effect.Effect<
		ReadonlyArray<VcsCodeSearchMatch>,
		VcsProviderError | VcsInstallationGoneError | VcsRepoUnavailableError | VcsRateLimitedError
	>

	/** Fetch a UTF-8 source file. `Option.none` is an expected missing path/ref. */
	readonly fetchSourceFile: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		path: string,
		ref: string,
	) => Effect.Effect<
		Option.Option<VcsSourceFile>,
		VcsProviderError | VcsInstallationGoneError | VcsRepoUnavailableError
	>
}
