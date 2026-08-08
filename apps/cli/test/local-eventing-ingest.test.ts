import { deepStrictEqual, strictEqual } from "node:assert"
import { describe, it } from "vitest"
import { __testables } from "../src/server/serve"

describe("Local eventing ingest seam", () => {
	it("requires maintenance authorization and exposes staged records only when requested", async () => {
		const eventing = {
			health: () => ({ activeProjections: 1 }),
			listActive: () => [],
			listReady: () => [{ id: "ready" }],
			listStaged: () => [{ id: "staged" }],
		}
		const unauthorized = __testables.handleEventingRead(
			eventing as never,
			"maintenance-secret",
			new Request("http://127.0.0.1/local/eventing/outbox?state=staged"),
			new URL("http://127.0.0.1/local/eventing/outbox?state=staged"),
		)
		strictEqual(unauthorized.status, 403)

		const request = new Request("http://127.0.0.1/local/eventing/outbox?state=staged", {
			headers: { "x-maple-maintenance-token": "maintenance-secret" },
		})
		const authorized = __testables.handleEventingRead(
			eventing as never,
			"maintenance-secret",
			request,
			new URL(request.url),
		)
		strictEqual(authorized.status, 200)
		deepStrictEqual(await authorized.json(), [{ id: "staged" }])
	})

	it("evaluates and stages before chDB write, then marks ready before acknowledging", async () => {
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
				return { events: [event], failures: [], typeMismatchFields: [] }
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
