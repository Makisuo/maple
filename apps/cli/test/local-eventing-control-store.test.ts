import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert"
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "vitest"
import type { MapleCloudEvent, SignalProjectionSpec } from "@maple/eventing-core"
import { eventingControlPath, LocalEventingControlStore } from "../src/server/eventing/control-store"

const withDataDir = async (run: (dataDir: string) => Promise<void>): Promise<void> => {
	const parent = mkdtempSync(join(tmpdir(), "maple-eventing-control-"))
	const dataDir = join(parent, "data")
	mkdirSync(dataDir, { recursive: true })
	try {
		await run(dataDir)
	} finally {
		rmSync(parent, { recursive: true, force: true })
	}
}

const projection = (overrides: Partial<SignalProjectionSpec> = {}): SignalProjectionSpec => ({
	id: "gitlab-issue-created",
	revision: 1,
	enabled: true,
	tenantId: "tenant-a",
	sourceKind: "otel.log",
	selector: {
		op: "eq",
		field: { namespace: "attribute", key: "event.name", type: "string" },
		value: { type: "string", value: "gitlab.issue.created" },
	},
	projector: { id: "gitlab.issue", version: 1, config: { includeTitle: true } },
	activeFrom: "2026-08-07T00:00:00Z",
	...overrides,
})

const event = (overrides: Partial<MapleCloudEvent> = {}): MapleCloudEvent => ({
	specversion: "1.0",
	id: "sha256:061c0b5d99b92ef65ab8813c6d84988e4b1582e705e0077c952e62a0e84b6b08",
	source: "urn:maple:source:otel:local",
	type: "dev.maple.gitlab.issue.created.v1",
	subject: "project/example/issues/42",
	time: "2026-08-07T19:42:00.123456789Z",
	datacontenttype: "application/json",
	dataschema: "urn:maple:event-schema:gitlab-issue:v1",
	tenantid: "tenant-a",
	projectionid: "gitlab-issue-created",
	projectionrevision: 1,
	projectorid: "gitlab.issue",
	projectorversion: 1,
	data: { iid: 42, title: "Example" },
	...overrides,
})

describe("LocalEventingControlStore", () => {
	it("stores immutable sequential revisions and only loads the active revision", async () =>
		withDataDir(async (dataDir) => {
			const store = await LocalEventingControlStore.open(dataDir)
			try {
				store.saveProjection(projection())
				deepStrictEqual(store.loadEnabledProjections("tenant-a"), [projection()])
				throws(
					() =>
						store.saveProjection(
							projection({ projector: { id: "changed", version: 1, config: {} } }),
						),
					/immutable/,
				)
				throws(() => store.saveProjection(projection({ revision: 3 })), /must be 2/)

				store.saveProjection(projection({ revision: 2, enabled: false }))
				deepStrictEqual(store.loadEnabledProjections("tenant-a"), [])
				store.saveProjection(projection({ revision: 3 }))
				deepStrictEqual(store.loadEnabledProjections("tenant-a"), [projection({ revision: 3 })])
				deepStrictEqual(store.validate(), {
					schemaVersion: 2,
					projectionRevisions: 3,
					projectionFailures: 0,
					stagedEvents: 0,
					readyEvents: 0,
				})
			} finally {
				store.close()
			}
		}))

	it("deduplicates staged events, rejects collisions, and preserves ready order", async () =>
		withDataDir(async (dataDir) => {
			const store = await LocalEventingControlStore.open(dataDir)
			try {
				deepStrictEqual(store.stageEvents([event(), event()]), {
					inserted: 1,
					deduplicated: 1,
					eventIds: [event().id, event().id],
				})
				throws(() => store.stageEvents([event({ data: { iid: 43 } })]), /collision/)
				throws(() => store.markReady(["unknown"]), /unknown event/)
				store.markReady([event().id])
				store.markReady([event().id])
				deepStrictEqual(store.listStaged().events, [])
				deepStrictEqual(
					store.listReady().events.map(({ event }) => event),
					[event()],
				)
			} finally {
				store.close()
			}
		}))

	it("survives restart and round-trips through a validated standalone snapshot", async () =>
		withDataDir(async (dataDir) => {
			let store = await LocalEventingControlStore.open(dataDir)
			store.saveProjection(projection())
			store.stageEvents([event()])
			store.markReady([event().id])
			store.recordProjectionFailures("tenant-a", [
				{
					projectionId: "gitlab-issue-created",
					projectionRevision: 1,
					occurrenceId: "issue-42",
					message: "test failure",
				},
			])
			store.close()

			store = await LocalEventingControlStore.open(dataDir)
			deepStrictEqual(store.loadEnabledProjections("tenant-a"), [projection()])
			deepStrictEqual(
				store.listReady().events.map(({ event }) => event),
				[event()],
			)
			const snapshot = join(dataDir, "backups", "snapshot", "control.sqlite")
			const validation = await store.backupTo(snapshot)
			deepStrictEqual(validation, {
				schemaVersion: 2,
				projectionRevisions: 1,
				projectionFailures: 1,
				stagedEvents: 0,
				readyEvents: 1,
			})
			store.close()

			const restored = join(dataDir, "restored")
			await LocalEventingControlStore.restoreSnapshot(snapshot, restored)
			deepStrictEqual(
				LocalEventingControlStore.validateSnapshot(eventingControlPath(restored)),
				validation,
			)
			const restoredStore = await LocalEventingControlStore.open(restored)
			try {
				deepStrictEqual(restoredStore.loadEnabledProjections("tenant-a"), [projection()])
				deepStrictEqual(
					restoredStore.listReady().events.map(({ event }) => event),
					[event()],
				)
			} finally {
				restoredStore.close()
			}
		}))

	it("checkpoints committed live WAL state before serializing", async () =>
		withDataDir(async (dataDir) => {
			const store = await LocalEventingControlStore.open(dataDir)
			try {
				store.saveProjection(projection())
				store.stageEvents([event()])
				store.markReady([event().id])
				const walPath = `${eventingControlPath(dataDir)}-wal`
				ok(existsSync(walPath))
				ok(statSync(walPath).size > 0, "test requires uncheckpointed WAL frames")

				const snapshot = join(dataDir, "backups", "live-wal", "control.sqlite")
				await store.backupTo(snapshot)
				strictEqual(statSync(walPath).size, 0)

				const restored = join(dataDir, "restored-live-wal")
				await LocalEventingControlStore.restoreSnapshot(snapshot, restored)
				const restoredStore = await LocalEventingControlStore.open(restored)
				try {
					deepStrictEqual(restoredStore.loadEnabledProjections("tenant-a"), [projection()])
					deepStrictEqual(
						restoredStore.listReady().events.map(({ event }) => event),
						[event()],
					)
				} finally {
					restoredStore.close()
				}
			} finally {
				store.close()
			}
		}))

	it("paginates every ready event and applies fail-closed outbox capacity", async () =>
		withDataDir(async (dataDir) => {
			const store = await LocalEventingControlStore.open(dataDir, {
				maxOutboxEvents: 2,
				maxOutboxBytes: 1024 * 1024,
			})
			try {
				const second = event({ id: "event-2", data: { iid: 43, title: "Second" } })
				const third = event({ id: "event-3", data: { iid: 44, title: "Third" } })
				const staged = store.stageEvents([event(), second])
				store.markReady(staged.eventIds)

				const firstPage = store.listReady(1)
				strictEqual(firstPage.events.length, 1)
				strictEqual(firstPage.nextCursor, firstPage.events[0]?.sequence)
				const secondPage = store.listReady(1, firstPage.nextCursor!)
				deepStrictEqual(
					[...firstPage.events, ...secondPage.events].map(({ event }) => event.id),
					[event().id, second.id],
				)
				strictEqual(secondPage.nextCursor, null)
				deepStrictEqual(store.stageEvents([event()]).deduplicated, 1)
				throws(() => store.stageEvents([third]), /outbox capacity exceeded/)
			} finally {
				store.close()
			}
		}))

	it("pages recovered events by first readiness transition instead of staging order", async () =>
		withDataDir(async (dataDir) => {
			const store = await LocalEventingControlStore.open(dataDir)
			try {
				const first = event({ id: "event-a" })
				const second = event({ id: "event-b" })
				store.stageEvents([first])
				store.stageEvents([second])
				store.markReady([second.id])

				const initialPage = store.listReady(1)
				deepStrictEqual(
					initialPage.events.map(({ event }) => event.id),
					[second.id],
				)
				const cursor = initialPage.events[0]!.sequence

				store.markReady([first.id])
				const recoveredPage = store.listReady(1, cursor)
				deepStrictEqual(
					recoveredPage.events.map(({ event }) => event.id),
					[first.id],
				)
				strictEqual(recoveredPage.events[0]!.sequence > cursor, true)
			} finally {
				store.close()
			}
		}))

	it("migrates schema 1 in place and keeps schema-1 snapshots restorable", async () =>
		withDataDir(async (dataDir) => {
			let store = await LocalEventingControlStore.open(dataDir)
			store.stageEvents([event()])
			store.markReady([event().id])
			store.close()

			const database = new Database(eventingControlPath(dataDir), {
				readwrite: true,
				strict: true,
				safeIntegers: true,
			})
			database.exec("DROP TABLE event_consumers")
			database.exec("PRAGMA user_version = 1")
			database.close(true)

			strictEqual(
				LocalEventingControlStore.validateSnapshot(eventingControlPath(dataDir)).schemaVersion,
				1,
			)
			store = await LocalEventingControlStore.open(dataDir)
			try {
				strictEqual(store.validate().schemaVersion, 2)
				deepStrictEqual(
					store.listReady().events.map(({ event }) => event.id),
					[event().id],
				)
				deepStrictEqual(store.listConsumers("tenant-a"), [])
			} finally {
				store.close()
			}
		}))

	it("leases whole batches, redelivers after expiry, and rejects stale acknowledgements", async () =>
		withDataDir(async (dataDir) => {
			const store = await LocalEventingControlStore.open(dataDir, {
				maxOutboxEvents: 10,
				maxOutboxBytes: 1024 * 1024,
				retainAcknowledgedReadyEvents: 0,
			})
			try {
				const second = event({ id: "event-2" })
				const third = event({ id: "event-3" })
				const staged = store.stageEvents([event(), second, third])
				store.markReady(staged.eventIds)
				store.registerConsumer("tenant-a", "matrix", "beginning", "2026-08-13T12:00:00.000Z")

				const firstClaim = store.claimReady("tenant-a", "matrix", 2, 10, "2026-08-13T12:00:01.000Z")
				strictEqual(firstClaim.leaseToken?.length, 64)
				deepStrictEqual(
					firstClaim.events.map(({ event }) => event.id),
					[event().id, second.id],
				)
				throws(
					() => store.claimReady("tenant-a", "matrix", 2, 10, "2026-08-13T12:00:02.000Z"),
					/active lease/,
				)
				throws(
					() =>
						store.acknowledgeClaim(
							"tenant-a",
							"matrix",
							"0".repeat(64),
							firstClaim.throughSequence!,
							"2026-08-13T12:00:03.000Z",
						),
					/token does not match/,
				)
				throws(
					() =>
						store.acknowledgeClaim(
							"tenant-a",
							"matrix",
							firstClaim.leaseToken!,
							firstClaim.events[0]!.sequence,
							"2026-08-13T12:00:03.000Z",
						),
					/complete claimed batch/,
				)

				const retry = store.claimReady("tenant-a", "matrix", 2, 10, "2026-08-13T12:00:12.000Z")
				deepStrictEqual(
					retry.events.map(({ event }) => event.id),
					[event().id, second.id],
				)
				strictEqual(retry.leaseToken === firstClaim.leaseToken, false)
				deepStrictEqual(
					store.acknowledgeClaim(
						"tenant-a",
						"matrix",
						retry.leaseToken!,
						retry.throughSequence!,
						"2026-08-13T12:00:13.000Z",
					),
					{
						consumerId: "matrix",
						acknowledgedThrough: retry.throughSequence,
						prunedEvents: 2,
					},
				)
				deepStrictEqual(
					store.listReady().events.map(({ event }) => event.id),
					[third.id],
				)
				throws(
					() =>
						store.acknowledgeClaim(
							"tenant-a",
							"matrix",
							firstClaim.leaseToken!,
							firstClaim.throughSequence!,
							"2026-08-13T12:00:14.000Z",
						),
					/no active lease/,
				)
			} finally {
				store.close()
			}
		}))

	it("prunes only after every active consumer advances and never prunes staged events", async () =>
		withDataDir(async (dataDir) => {
			const store = await LocalEventingControlStore.open(dataDir, {
				maxOutboxEvents: 10,
				maxOutboxBytes: 1024 * 1024,
				retainAcknowledgedReadyEvents: 0,
			})
			try {
				const second = event({ id: "event-2" })
				const third = event({ id: "event-3" })
				const stranded = event({ id: "event-staged" })
				const ready = store.stageEvents([event(), second, third])
				store.markReady(ready.eventIds)
				store.stageEvents([stranded])
				store.registerConsumer("tenant-a", "matrix-a", "beginning")
				store.registerConsumer("tenant-a", "matrix-b", "beginning")

				const fast = store.claimReady("tenant-a", "matrix-a", 3, 30)
				strictEqual(
					store.acknowledgeClaim("tenant-a", "matrix-a", fast.leaseToken!, fast.throughSequence!)
						.prunedEvents,
					0,
				)
				const slow = store.claimReady("tenant-a", "matrix-b", 2, 30)
				strictEqual(
					store.acknowledgeClaim("tenant-a", "matrix-b", slow.leaseToken!, slow.throughSequence!)
						.prunedEvents,
					2,
				)
				deepStrictEqual(
					store.listReady().events.map(({ event }) => event.id),
					[third.id],
				)
				store.disableConsumer("tenant-a", "matrix-b")
				deepStrictEqual(store.listReady().events, [])
				deepStrictEqual(
					store.listStaged().events.map(({ event }) => event.id),
					[stranded.id],
				)
			} finally {
				store.close()
			}
		}))

	it("starts latest consumers after backlog and checkpoints active leases", async () =>
		withDataDir(async (dataDir) => {
			let store = await LocalEventingControlStore.open(dataDir)
			store.stageEvents([event()])
			store.markReady([event().id])
			const registered = store.registerConsumer(
				"tenant-a",
				"matrix",
				"latest",
				"2099-01-01T00:00:00.000Z",
			)
			strictEqual(registered.lastAcknowledgedSequence, store.listReady().events[0]!.sequence)
			deepStrictEqual(
				store.claimReady("tenant-a", "matrix", 10, 300, "2099-01-01T00:00:01.000Z").events,
				[],
			)

			const second = event({ id: "event-2" })
			store.stageEvents([second])
			store.markReady([second.id])
			const claim = store.claimReady("tenant-a", "matrix", 10, 300, "2099-01-01T00:00:02.000Z")
			const snapshot = join(dataDir, "backups", "consumer", "control.sqlite")
			await store.backupTo(snapshot)
			store.close()

			const restored = join(dataDir, "restored-consumer")
			await LocalEventingControlStore.restoreSnapshot(snapshot, restored)
			store = await LocalEventingControlStore.open(restored)
			try {
				deepStrictEqual(
					store.listConsumers("tenant-a")[0]?.claimedThroughSequence,
					claim.throughSequence,
				)
				strictEqual(
					store.acknowledgeClaim(
						"tenant-a",
						"matrix",
						claim.leaseToken!,
						claim.throughSequence!,
						"2099-01-01T00:00:03.000Z",
					).acknowledgedThrough,
					claim.throughSequence,
				)
			} finally {
				store.close()
			}
		}))

	it("refuses a symlink in place of the database", async () =>
		withDataDir(async (dataDir) => {
			const controlPath = eventingControlPath(dataDir)
			mkdirSync(join(dataDir, "control"), { recursive: true })
			symlinkSync(join(dataDir, "target.sqlite"), controlPath)
			await rejects(() => LocalEventingControlStore.open(dataDir), /not a real file/)
			strictEqual(controlPath.endsWith("control/eventing.sqlite"), true)
		}))
})
