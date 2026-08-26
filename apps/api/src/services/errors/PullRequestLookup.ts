import type { OrgId, PullRequestSummary } from "@maple/domain/http"
import { Context, Effect, Layer, Option } from "effect"

/**
 * Reading a pull request's current state from whichever provider hosts it.
 *
 * A port, for the same reason {@link PullRequestEventSink} is one — but pointing
 * the other way. The sink carries provider events *into* the errors side; this
 * carries a question *out* of it, so the errors services can enrich a link
 * without importing the VCS layer and closing a cycle between the two.
 *
 * `Option.none` is the answer for every routine miss — no such PR, a repository
 * this org never connected, a provider that is momentarily unreachable. The
 * binding in `pull-request-lookup-live.ts` absorbs those, so a caller only ever
 * sees "we know something about this PR" or "we do not". That is what keeps
 * hydration best-effort: attaching a PR must never fail because GitHub had a bad
 * minute, and `error_issue_pull_requests` is deliberately not FK'd to
 * `vcs_repositories` precisely so an unsynced repo stays linkable.
 */
export interface PullRequestLookupApi {
	readonly fetch: (
		orgId: OrgId,
		repoFullName: string,
		number: number,
	) => Effect.Effect<Option.Option<PullRequestSummary>>
	/**
	 * Every repository this org has connected, by `owner/name`. Used to pick which
	 * repository the attach-a-PR picker opens on. An empty array is the honest
	 * answer for an org with no integration, and — like `fetch` — for a provider
	 * that could not be reached: a suggestion is a convenience, and failing a
	 * perfectly good listing over it would be a poor trade.
	 */
	readonly listRepositories: (orgId: OrgId) => Effect.Effect<ReadonlyArray<string>>
}

export class PullRequestLookup extends Context.Service<PullRequestLookup, PullRequestLookupApi>()(
	"@maple/api/services/errors/PullRequestLookup",
	{
		// Default: know nothing. A deployment without a VCS integration wired (or a
		// test that does not care) still links pull requests, exactly as it did
		// before hydration existed — the link is stored unenriched.
		make: Effect.succeed<PullRequestLookupApi>({
			fetch: () => Effect.succeedNone,
			listRepositories: () => Effect.succeed([]),
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
	static readonly none = Layer.succeed(this, {
		fetch: () => Effect.succeedNone,
		listRepositories: () => Effect.succeed([]),
	})
}
