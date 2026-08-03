import {
	isInstallationProcessable,
	type VcsQueueError,
	type VcsRepoDecodeError,
	type VcsRepoPersistenceError,
	type VcsSyncJob,
} from "@maple/domain/http"
import { Context, Effect, Layer } from "effect"
import { VcsRepository } from "./VcsRepository"
import { VcsSyncQueue } from "./VcsSyncQueue"

// ---------------------------------------------------------------------------
// Vendor-agnostic producer for the periodic (cron) VCS sync. Once every 12h it
// enqueues one `installation-sync` job (reason "scheduled") per processable
// installation across every org. All provider work — re-listing repos,
// refreshing branches, backfilling each tracked branch's commits — happens in
// the queue consumer (VcsSyncService) behind the VcsProviderClient port, so this
// scheduler never touches a provider module. It is the backstop for any webhook
// delivery (push, branch, installation) that was dropped.
// ---------------------------------------------------------------------------

interface VcsScheduledSyncResult {
	/** Installations found across all orgs, regardless of status. */
	readonly installationsTotal: number
	/** Jobs enqueued (one per processable installation). */
	readonly enqueued: number
	/** Installations skipped because they are not processable (suspended/disconnected). */
	readonly skipped: number
}

export interface VcsScheduledSyncServiceShape {
	readonly runScheduledSync: () => Effect.Effect<
		VcsScheduledSyncResult,
		VcsRepoPersistenceError | VcsRepoDecodeError | VcsQueueError
	>
}

export class VcsScheduledSyncService extends Context.Service<
	VcsScheduledSyncService,
	VcsScheduledSyncServiceShape
>()("@maple/api/services/vcs/VcsScheduledSyncService", {
	make: Effect.gen(function* () {
		const repo = yield* VcsRepository
		const queue = yield* VcsSyncQueue

		const runScheduledSync = Effect.fn("VcsScheduledSyncService.runScheduledSync")(
			function* () {
				const installations = yield* repo.listAllInstallations()
				// Filter here so we don't enqueue no-op work; the consumer would skip
				// suspended/disconnected installations anyway.
				const processable = installations.filter(isInstallationProcessable)

				const jobs = processable.map(
					(installation): VcsSyncJob => ({
						kind: "installation-sync",
						provider: installation.provider,
						externalInstallationId: installation.externalInstallationId,
						reason: "scheduled",
					}),
				)
				// `sendBatch` handles chunking to platform per-call caps internally.
				yield* queue.sendBatch(jobs)

				const result: VcsScheduledSyncResult = {
					installationsTotal: installations.length,
					enqueued: jobs.length,
					skipped: installations.length - jobs.length,
				}
				yield* Effect.annotateCurrentSpan({
					"vcs.scheduled.installations_total": result.installationsTotal,
					"vcs.scheduled.enqueued": result.enqueued,
					"vcs.scheduled.skipped": result.skipped,
					"vcs.scheduled.outcome": "completed",
				})
				return result
			},
			Effect.tapCause(() => Effect.annotateCurrentSpan({ "vcs.scheduled.outcome": "failed" })),
		)

		return { runScheduledSync } satisfies VcsScheduledSyncServiceShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
