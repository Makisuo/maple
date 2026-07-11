import { describe, expect, it } from "vitest"
import type { DashboardRow } from "@/lib/collections/dashboards"
import { deriveDashboardsList } from "./dashboards-list-model"

const ISO_OLD = "2026-01-01T00:00:00.000Z"
const ISO_MID = "2026-03-01T00:00:00.000Z"
const ISO_NEW = "2026-06-01T00:00:00.000Z"

function makePayload(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id,
		name: `Dashboard ${id}`,
		timeRange: { type: "relative", value: "12h" },
		widgets: [],
		createdAt: ISO_OLD,
		updatedAt: ISO_OLD,
		...overrides,
	}
}

function makeRow(id: string, updatedAt: string, payloadOverrides: Record<string, unknown> = {}): DashboardRow {
	return {
		org_id: "org_test",
		id,
		name: `Dashboard ${id}`,
		payload_json: makePayload(id, { updatedAt, ...payloadOverrides }),
		created_at: ISO_OLD,
		updated_at: updatedAt,
		created_by: "user_test",
		updated_by: "user_test",
		version: 1,
	}
}

describe("deriveDashboardsList", () => {
	it("orders dashboards newest-updated first", () => {
		const list = deriveDashboardsList([
			makeRow("dash-old", ISO_OLD),
			makeRow("dash-new", ISO_NEW),
			makeRow("dash-mid", ISO_MID),
		])
		expect(list.map((d) => d.id)).toEqual(["dash-new", "dash-mid", "dash-old"])
	})

	it("drops rows whose payload_json fails to decode", () => {
		const corrupt: DashboardRow = {
			...makeRow("dash-corrupt", ISO_NEW),
			// Missing required fields (name/timeRange/widgets/…) — undecodable.
			payload_json: { id: "dash-corrupt" },
		}
		const list = deriveDashboardsList([corrupt, makeRow("dash-ok", ISO_OLD)])
		expect(list.map((d) => d.id)).toEqual(["dash-ok"])
	})

	it("maps the decoded document into the web Dashboard shape", () => {
		const list = deriveDashboardsList([
			makeRow("dash-a", ISO_MID, {
				name: "Latency overview",
				description: "p95 across services",
				tags: ["perf", "sre"],
				widgets: [
					{
						id: "w1",
						visualization: "timeseries",
						dataSource: { endpoint: "spanMetrics" },
						display: { title: "p95" },
						layout: { x: 0, y: 0, w: 4, h: 5 },
					},
				],
			}),
		])
		expect(list).toHaveLength(1)
		const dashboard = list[0]
		expect(dashboard.id).toBe("dash-a")
		expect(dashboard.name).toBe("Latency overview")
		expect(dashboard.description).toBe("p95 across services")
		expect(dashboard.tags).toEqual(["perf", "sre"])
		expect(dashboard.updatedAt).toBe(ISO_MID)
		expect(dashboard.timeRange).toEqual({ type: "relative", value: "12h" })
		expect(dashboard.widgets).toHaveLength(1)
		expect(dashboard.widgets[0]).toMatchObject({
			id: "w1",
			visualization: "timeseries",
			layout: { x: 0, y: 0, w: 4, h: 5 },
		})
	})
})
