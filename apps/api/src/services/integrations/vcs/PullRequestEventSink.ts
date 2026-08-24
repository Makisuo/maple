import type { PullRequestEventJob } from "@maple/domain/http"
import type { OrgId } from "@maple/domain/primitives"
import { Context, Effect, Layer } from "effect"

/**
 * Where a pull-request webhook goes after the VCS layer has resolved its owning
 * org.
 *
 * A port rather than a direct call into the errors services, for the same reason
 * `VcsProviderClient` is one: this directory maps provider events to VCS facts
 * and knows nothing about issues, verification windows, or workflow states. The
 * sink is bound to `IssueFixVerificationService` in the composition roots, and
 * to a recording stub in tests — which is what lets the sync-service tests
 * assert "this delivery was forwarded once, with this org" without standing up
 * the whole error-issue stack.
 *
 * Failures are the sink's own business. It returns `Effect<void, never>` so a
 * problem on the issues side can never fail a webhook job and trigger a GitHub
 * redelivery of an event the VCS layer already handled correctly.
 */
export interface PullRequestEventSinkApi {
	readonly onPullRequestEvent: (orgId: OrgId, job: PullRequestEventJob) => Effect.Effect<void>
}

export class PullRequestEventSink extends Context.Service<PullRequestEventSink, PullRequestEventSinkApi>()(
	"@maple/api/services/integrations/vcs/PullRequestEventSink",
	{
		// Default: accept and drop. A deployment that has not wired the errors side
		// (or a test that does not care) still processes webhooks rather than failing
		// them, and the no-op is explicit instead of an accidental missing binding.
		make: Effect.succeed<PullRequestEventSinkApi>({ onPullRequestEvent: () => Effect.void }),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
	static readonly noop = Layer.succeed(this, { onPullRequestEvent: () => Effect.void })
}
