import { afterEach, assert, describe, it } from "@effect/vitest"
import { VcsQueueError, type OrgId, type VcsSyncJob } from "@maple/domain/http"
import { Effect, Exit, Layer } from "effect"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { VcsRepository } from "@/services/integrations/vcs/VcsRepository"
import { VcsScheduledSyncService } from "@/services/integrations/vcs/VcsScheduledSyncService"
import {
	asOrgId,
	asUserId,
	expectSome,
	findError,
	recordingQueueLayer,
	testRepoLayer,
	type VcsRepo,
} from "./harness"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

// Wire VcsScheduledSyncService over an in-memory PGlite (real repo) and a
// recording VcsSyncQueue that captures every enqueued job. When `failQueue` is
// set, `sendBatch` fails with a VcsQueueError instead, to exercise propagation.
const schedulerLayer = (testDb: TestDb, sent: Array<VcsSyncJob>, opts?: { readonly failQueue?: boolean }) => {
	const data = testRepoLayer(testDb)
	const queue = recordingQueueLayer(
		sent,
		opts?.failQueue ? { failBatch: () => new VcsQueueError({ message: "simulated queue outage" }) } : {},
	)
	const service = VcsScheduledSyncService.layer.pipe(Layer.provide(Layer.mergeAll(data, queue)))
	return Layer.mergeAll(service, data)
}

// Seed one installation for an org with a given external id; returns the entity.
const seedInstallation = (repo: VcsRepo, orgId: OrgId, externalInstallationId: string) =>
	Effect.gen(function* () {
		yield* repo.upsertInstallation({
			orgId,
			provider: "github",
			externalInstallationId,
			accountLogin: `octo-${externalInstallationId}`,
			accountType: "organization",
			externalAccountId: `acct-${externalInstallationId}`,
			accountAvatarUrl: null,
			repositorySelection: "all",
			installedByUserId: asUserId("user_1"),
		})
		return expectSome(yield* repo.resolveInstallation("github", externalInstallationId))
	})

describe("VcsScheduledSyncService.runScheduledSync", () => {
	it.effect("enqueues one scheduled installation-sync per installation across orgs", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsScheduledSyncService
			const repo = yield* VcsRepository
			yield* seedInstallation(repo, asOrgId("org_a"), "1")
			yield* seedInstallation(repo, asOrgId("org_b"), "2")

			const result = yield* svc.runScheduledSync()

			assert.strictEqual(result.installationsTotal, 2)
			assert.strictEqual(result.enqueued, 2)
			assert.strictEqual(result.skipped, 0)
			assert.strictEqual(sent.length, 2)
			assert.ok(
				sent.every((j) => j.kind === "installation-sync" && j.reason === "scheduled"),
				"every job is a scheduled installation-sync",
			)
			assert.deepStrictEqual(sent.map((j) => j.externalInstallationId).sort(), ["1", "2"])
		}).pipe(Effect.provide(schedulerLayer(testDb, sent)))
	})

	it.effect("skips suspended and disconnected installations (the processable gate)", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsScheduledSyncService
			const repo = yield* VcsRepository
			const active = yield* seedInstallation(repo, asOrgId("org_a"), "1")
			const suspended = yield* seedInstallation(repo, asOrgId("org_b"), "2")
			const disconnected = yield* seedInstallation(repo, asOrgId("org_c"), "3")
			yield* repo.markInstallationStatus(suspended.id, "suspended")
			yield* repo.markInstallationStatus(disconnected.id, "disconnected")

			const result = yield* svc.runScheduledSync()

			assert.strictEqual(result.installationsTotal, 3)
			assert.strictEqual(result.enqueued, 1)
			assert.strictEqual(result.skipped, 2)
			assert.strictEqual(sent.length, 1)
			assert.strictEqual(sent[0]?.externalInstallationId, active.externalInstallationId)
		}).pipe(Effect.provide(schedulerLayer(testDb, sent)))
	})

	it.effect("enqueues nothing when there are no installations", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsScheduledSyncService
			const result = yield* svc.runScheduledSync()
			assert.strictEqual(result.installationsTotal, 0)
			assert.strictEqual(result.enqueued, 0)
			assert.strictEqual(sent.length, 0)
		}).pipe(Effect.provide(schedulerLayer(testDb, sent)))
	})

	it.effect("propagates a queue failure as VcsQueueError", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsScheduledSyncService
			const repo = yield* VcsRepository
			yield* seedInstallation(repo, asOrgId("org_a"), "1")
			const exit = yield* Effect.exit(svc.runScheduledSync())
			assert.ok(Exit.isFailure(exit), "the tick surfaces the queue failure")
			assert.ok(findError(exit) instanceof VcsQueueError)
		}).pipe(Effect.provide(schedulerLayer(testDb, sent, { failQueue: true })))
	})
})
