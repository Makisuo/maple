import { Effect, Layer } from "effect"
import { PullRequestEventSink } from "@/services/integrations/vcs/PullRequestEventSink"
import { IssueFixVerificationService } from "./IssueFixVerificationService"

/**
 * Binds the VCS layer's pull-request port to the error-issue side.
 *
 * The adapter lives here, not in the VCS directory, so the dependency points one
 * way: errors knows about the port, VCS does not know about issues. It also
 * absorbs the impedance mismatch — the port promises never to fail, while the
 * service can fail on persistence — which is deliberate. A webhook that already
 * did its VCS work must not be redelivered by GitHub because the issues side
 * had a bad minute; the failure is logged and the delivery stands.
 */
export const PullRequestEventSinkLive = Layer.effect(
	PullRequestEventSink,
	Effect.gen(function* () {
		const verification = yield* IssueFixVerificationService
		return {
			onPullRequestEvent: (orgId, job) =>
				verification
					.onPullRequestEvent({
						orgId,
						provider: job.provider,
						externalRepoId: job.externalRepoId,
						repoFullName: job.repoFullName,
						number: job.number,
						action: job.action,
						url: job.url,
						title: job.title,
						body: job.body,
						authorLogin: job.authorLogin,
						merged: job.merged,
						mergeCommitSha: job.mergeCommitSha,
						mergedAtMs: job.mergedAtMs,
					})
					.pipe(
						Effect.flatMap((outcome) =>
							Effect.annotateCurrentSpan({
								"vcs.pull_request.links_auto_created": outcome.linksAutoCreated,
								"vcs.pull_request.links_updated": outcome.linksUpdated,
								"vcs.pull_request.verifications_opened": outcome.verificationsOpened,
							}),
						),
						Effect.catchTag("@maple/http/errors/ErrorPersistenceError", (error) =>
							Effect.logError("[FixVerification] pull request event could not be applied").pipe(
								Effect.annotateLogs({
									orgId,
									repoFullName: job.repoFullName,
									number: job.number,
									error: error.message,
								}),
							),
						),
					),
		}
	}),
)
