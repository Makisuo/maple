import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert"
import { describe, it } from "vitest"
import { __testables } from "../src/server/serve"

describe("Local eventing ingest seam", () => {
	it("requires maintenance authorization and exposes staged records only when requested", async () => {
		const eventing = {
			health: () => ({ activeProjections: 1 }),
			listActive: () => [],
			listReady: () => ({ events: [{ sequence: 1, event: { id: "ready" } }], nextCursor: null }),
			listStaged: (_limit: number, after: number) => ({
				events: [{ sequence: after + 1, event: { id: "staged" } }],
				nextCursor: null,
			}),
		}
		const unauthorized = __testables.handleEventingRead(
			eventing as never,
			"maintenance-secret",
			new Request("http://127.0.0.1/local/eventing/outbox?state=staged"),
			new URL("http://127.0.0.1/local/eventing/outbox?state=staged"),
		)
		strictEqual(unauthorized.status, 403)

		const request = new Request("http://127.0.0.1/local/eventing/outbox?state=staged&after=41", {
			headers: { "x-maple-maintenance-token": "maintenance-secret" },
		})
		const authorized = __testables.handleEventingRead(
			eventing as never,
			"maintenance-secret",
			request,
			new URL(request.url),
		)
		strictEqual(authorized.status, 200)
		deepStrictEqual(await authorized.json(), {
			events: [{ sequence: 42, event: { id: "staged" } }],
			nextCursor: null,
		})
	})

	it("authenticates and reads activation bodies before closing admission", async () => {
		const gate = new __testables.RequestQuiescenceGate()
		const neverClosed = new ReadableStream<Uint8Array>()
		const unauthorized = await __testables.handleProjectionActivation(
			{} as never,
			gate,
			"maintenance-secret",
			{
				headers: new Headers(),
				body: neverClosed,
			} as Request,
		)
		strictEqual(unauthorized.status, 403)
		const afterUnauthorized = gate.enter()
		ok(afterUnauthorized, "invalid authorization must not close admission")
		afterUnauthorized()

		const checkpointUnauthorized = await __testables.handleCheckpointBackup(
			{} as never,
			{} as never,
			"/unused",
			gate,
			"maintenance-secret",
			{ headers: new Headers(), body: neverClosed } as Request,
		)
		strictEqual(checkpointUnauthorized.status, 403)
		const afterCheckpointUnauthorized = gate.enter()
		ok(afterCheckpointUnauthorized, "checkpoint authorization must precede exclusivity")
		afterCheckpointUnauthorized()

		let controller!: ReadableStreamDefaultController<Uint8Array>
		const slowBody = new ReadableStream<Uint8Array>({
			start(value) {
				controller = value
			},
		})
		let committed = false
		const pending = __testables.handleProjectionActivation(
			{
				prepareActivation: (body: unknown) => ({ body }),
				commitActivation: () => {
					committed = true
				},
				listActive: () => [],
			} as never,
			gate,
			"maintenance-secret",
			{
				headers: new Headers({ "x-maple-maintenance-token": "maintenance-secret" }),
				body: slowBody,
			} as Request,
		)
		await Promise.resolve()
		const whileReading = gate.enter()
		ok(whileReading, "an incomplete request body must not close admission")
		whileReading()
		controller.enqueue(new TextEncoder().encode("{}"))
		controller.close()
		strictEqual((await pending).status, 200)
		strictEqual(committed, true)
	})

	it("bounds activation bodies and reports concurrent maintenance intentionally", async () => {
		const oversized = new Request("http://127.0.0.1/local/eventing/projections", {
			method: "POST",
			body: "123456789",
		})
		await rejects(() => __testables.readBoundedJson(oversized, 8), /exceeds 8 bytes/)

		const gate = new __testables.RequestQuiescenceGate()
		let releaseMaintenance!: () => void
		const maintenance = gate.exclusive(
			() =>
				new Promise<void>((resolve) => {
					releaseMaintenance = resolve
				}),
		)
		await Promise.resolve()
		const response = await __testables.handleProjectionActivation(
			{
				prepareActivation: () => ({}),
				commitActivation: () => undefined,
				listActive: () => [],
			} as never,
			gate,
			"maintenance-secret",
			new Request("http://127.0.0.1/local/eventing/projections", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-maple-maintenance-token": "maintenance-secret",
				},
				body: "{}",
			}),
		)
		strictEqual(response.status, 409)
		releaseMaintenance()
		await maintenance
	})

	it("isolates projection failures, stores telemetry, and makes sibling events ready", async () => {
		const order: string[] = []
		const event = { id: "event-1" }
		const db = {
			exec: () => {
				order.push("chdb-insert")
			},
		}
		const authority = {
			isRetired: () => false,
			filterBatch: (_datasource: string, ndjson: string) => {
				order.push("retention-filter")
				return { ndjson, accepted: 1, rejected: 0 }
			},
		}
		const eventing = {
			evaluateOtlp: () => {
				order.push("evaluate")
				return {
					events: [event],
					failures: [
						{
							projectionId: "oversized-projector",
							projectionRevision: 1,
							occurrenceId: "occurrence-1",
							message: "CloudEvent exceeds 262144 UTF-8 bytes",
						},
					],
					typeMismatchFields: [],
				}
			},
			persistFailures: () => order.push("persist-failures"),
			stage: () => {
				order.push("stage")
				return { inserted: 1, deduplicated: 0, eventIds: [event.id] }
			},
			markReady: () => order.push("ready"),
		}
		const request = new Request("http://127.0.0.1/v1/logs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				resourceLogs: [
					{
						scopeLogs: [
							{
								logRecords: [
									{
										timeUnixNano: "1786131720123456789",
										body: { stringValue: "one" },
									},
								],
							},
						],
					},
				],
			}),
		})

		const result = await __testables.ingest(
			db as never,
			authority as never,
			eventing as never,
			"logs",
			request,
		)
		strictEqual(result.response.status, 200)
		strictEqual(result.accepted, 1)
		deepStrictEqual(order, [
			"evaluate",
			"persist-failures",
			"stage",
			"retention-filter",
			"chdb-insert",
			"ready",
		])
	})

	it("leaves a staged event non-ready when the warehouse write fails", async () => {
		let markedReady = false
		const request = new Request("http://127.0.0.1/v1/logs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: "one" } }] }] }],
			}),
		})
		const result = await __testables.ingest(
			{
				exec: () => {
					throw new Error("write failed")
				},
			} as never,
			{
				isRetired: () => false,
				filterBatch: (_datasource: string, ndjson: string) => ({
					ndjson,
					accepted: 1,
					rejected: 0,
				}),
			} as never,
			{
				evaluateOtlp: () => ({ events: [{ id: "event-1" }], failures: [], typeMismatchFields: [] }),
				persistFailures: () => undefined,
				stage: () => ({ inserted: 1, deduplicated: 0, eventIds: ["event-1"] }),
				markReady: () => {
					markedReady = true
				},
			} as never,
			"logs",
			request,
		)
		strictEqual(result.response.status, 500)
		strictEqual(markedReady, false)
	})
})
