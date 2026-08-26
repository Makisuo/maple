import { Effect, Layer, Option } from "effect"
import { VcsSourceService } from "@/services/integrations/vcs/VcsSourceService"
import { PullRequestLookup } from "./PullRequestLookup"

/**
 * Binds the errors side's pull-request lookup to the VCS read surface.
 *
 * The adapter lives here for the same reason `PullRequestEventSinkLive` does:
 * the dependency points one way, and the impedance mismatch is absorbed at the
 * seam. `VcsSourceService` fails when the org has no installation, when the
 * repository is not connected, or when the provider is unreachable; the port
 * cannot fail. Every one of those is a legitimate "we do not know about this
 * PR" — the user pasted a link to a repo Maple never synced, or GitHub is
 * having a bad minute — and none of them should stop the link being stored.
 */
export const PullRequestLookupLive = Layer.effect(
	PullRequestLookup,
	Effect.gen(function* () {
		const source = yield* VcsSourceService
		return {
			fetch: (orgId, repoFullName, number) =>
				source.fetchPullRequest(orgId, repoFullName, number).pipe(
					Effect.tapError((error) =>
						Effect.annotateCurrentSpan({
							"vcs.pull_request.lookup_skipped": error._tag,
						}),
					),
					Effect.orElseSucceed(() => Option.none()),
				),
			listRepositories: (orgId) =>
				source.listRepositories(orgId).pipe(
					Effect.map((repos) => repos.map((repo) => repo.fullName)),
					Effect.orElseSucceed(() => []),
				),
		}
	}),
)
