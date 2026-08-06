import { CollectionError } from "@maple/unitflow/db"
import type * as Db from "@maple/unitflow/db"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { describe, expect, it } from "vitest"
import type { DashboardRow } from "@/lib/collections/dashboards"
import { buildList, deriveDashboardsList } from "./dashboards-list-model"

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

function makeRow(
	id: string,
	updatedAt: string,
	payloadOverrides: Record<string, unknown> = {},
): DashboardRow {
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

describe("buildList", () => {
	const rowsInitial: Db.CollectionState<DashboardRow> = AsyncResult.initial(true)
	const rowsFailed: Db.CollectionState<DashboardRow> = AsyncResult.fail(
		new CollectionError({ reason: "load-timeout", message: "Collection timed out while loading" }),
	)
	const rowsReady = (rows: ReadonlyArray<DashboardRow>): Db.CollectionState<DashboardRow> =>
		AsyncResult.success(rows)

	const fallbackDashboards = deriveDashboardsList([makeRow("dash-http", ISO_NEW)])

	it("renders synced rows and never reaches for the fallback", () => {
		const list = buildList(rowsReady([makeRow("dash-live", ISO_NEW)]), {
			status: "ready",
			dashboards: fallbackDashboards,
		})
		expect(list).toMatchObject({ phase: "ready", degraded: false })
		expect(list.phase === "ready" && list.dashboards.map((d) => d.id)).toEqual(["dash-live"])
	})

	it("stays on the skeleton for the tick between the failure and its fallback request", () => {
		expect(buildList(rowsFailed, { status: "idle" })).toEqual({ phase: "loading" })
		expect(buildList(rowsFailed, { status: "loading" })).toEqual({ phase: "loading" })
	})

	it("serves the HTTP snapshot, flagged degraded, once sync has failed", () => {
		const list = buildList(rowsFailed, { status: "ready", dashboards: fallbackDashboards })
		expect(list).toMatchObject({ phase: "ready", degraded: true })
		expect(list.phase === "ready" && list.dashboards.map((d) => d.id)).toEqual(["dash-http"])
	})

	it("keeps serving the snapshot while a heal attempt re-enters loading", () => {
		// The recreate puts the rows store back to `initial`; blinking the list away
		// every 30s while heal attempts cycle would be worse than a frozen list.
		const list = buildList(rowsInitial, { status: "ready", dashboards: fallbackDashboards })
		expect(list).toMatchObject({ phase: "ready", degraded: true })
	})

	it("errors only when sync and the HTTP fallback are both down", () => {
		expect(buildList(rowsFailed, { status: "failed" })).toMatchObject({ phase: "error" })
	})

	it("reports a genuinely empty org as ready, not degraded", () => {
		expect(buildList(rowsReady([]), { status: "idle" })).toEqual({
			phase: "ready",
			dashboards: [],
			degraded: false,
		})
	})

	it("keeps an empty org out of degraded even after the snapshot has latched", () => {
		// The fallback store latches at `ready` for the whole session once it has
		// loaded once. Treating "no rows" as "sync is down" made a healthy org with
		// no dashboards read-only, which disables the only way out of that state:
		// the "New dashboard" button.
		const list = buildList(rowsReady([]), { status: "ready", dashboards: fallbackDashboards })
		expect(list).toEqual({ phase: "ready", dashboards: [], degraded: false })
	})
})
