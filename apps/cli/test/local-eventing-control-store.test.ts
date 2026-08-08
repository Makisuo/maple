import { deepStrictEqual, rejects, strictEqual, throws } from "node:assert"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
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
					schemaVersion: 1,
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
				deepStrictEqual(store.listStaged(), [])
				deepStrictEqual(store.listReady(), [event()])
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
			deepStrictEqual(store.listReady(), [event()])
			const snapshot = join(dataDir, "backups", "snapshot", "control.sqlite")
			const validation = await store.backupTo(snapshot)
			deepStrictEqual(validation, {
				schemaVersion: 1,
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
				deepStrictEqual(restoredStore.listReady(), [event()])
			} finally {
				restoredStore.close()
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
