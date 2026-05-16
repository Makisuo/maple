import { createClient } from "@libsql/client"
import { DashboardDocument } from "@maple/domain/http"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import { Schema } from "effect"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { beforeEach, describe, expect, it } from "vitest"
import type { MapleLibsqlClient } from "../client"
import { dashboards, dashboardVersions } from "../schema"
import * as schema from "../schema"
import { reshapeDashboardWidgets } from "./0012-dashboard-widget-reshape"

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle")
const decodeDashboard = Schema.decodeUnknownSync(DashboardDocument)

function legacyPayload() {
	return {
		id: "dash-legacy",
		name: "Legacy Dashboard",
		timeRange: { type: "relative", value: "1h" },
		variables: [{ name: "env" }],
		widgets: [
			{
				id: "w1",
				visualization: "chart",
				dataSource: {
					endpoint: "custom_query_builder_timeseries",
					params: {
						queries: [
							{
								id: "q1",
								name: "A",
								dataSource: "traces",
								aggregation: "count",
								metricName: "",
								metricType: "gauge",
								isMonotonic: false,
								signalSource: "default",
							},
						],
					},
				},
				display: { title: "Span count" },
				layout: { x: 0, y: 0, w: 6, h: 4 },
			},
		],
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
	}
}

async function makeDb(): Promise<MapleLibsqlClient> {
	const client = createClient({ url: ":memory:" })
	const db = drizzle(client, { schema })
	await migrate(db, { migrationsFolder })
	return db
}

describe("reshapeDashboardWidgets", () => {
	let db: MapleLibsqlClient

	beforeEach(async () => {
		db = await makeDb()
		const payload = JSON.stringify(legacyPayload())
		await db.insert(dashboards).values({
			orgId: "org-1",
			id: "dash-legacy",
			name: "Legacy Dashboard",
			payloadJson: payload,
			createdAt: 0,
			updatedAt: 0,
			createdBy: "user-1",
			updatedBy: "user-1",
			version: 0,
		})
		await db.insert(dashboardVersions).values({
			orgId: "org-1",
			id: "ver-1",
			dashboardId: "dash-legacy",
			versionNumber: 1,
			snapshotJson: payload,
			changeKind: "created",
			createdAt: 0,
			createdBy: "user-1",
		})
	})

	it("migrates payloadJson and snapshotJson to the current decodable shape", async () => {
		await reshapeDashboardWidgets(db)

		const [row] = await db
			.select({ payloadJson: dashboards.payloadJson })
			.from(dashboards)
			.where(eq(dashboards.id, "dash-legacy"))
		const doc = JSON.parse(row!.payloadJson)
		expect("variables" in doc).toBe(false)
		const query = doc.widgets[0].dataSource.params.queries[0]
		expect("metricName" in query).toBe(false)
		expect("metricType" in query).toBe(false)
		// The strict DashboardDocument schema decodes the migrated payload.
		expect(() => decodeDashboard(doc)).not.toThrow()

		const [versionRow] = await db
			.select({ snapshotJson: dashboardVersions.snapshotJson })
			.from(dashboardVersions)
			.where(eq(dashboardVersions.id, "ver-1"))
		const snapshot = JSON.parse(versionRow!.snapshotJson)
		expect("variables" in snapshot).toBe(false)
		expect(() => decodeDashboard(snapshot)).not.toThrow()
	})

	it("is idempotent — a second run is a guarded no-op", async () => {
		await reshapeDashboardWidgets(db)
		const [first] = await db
			.select({ payloadJson: dashboards.payloadJson })
			.from(dashboards)
			.where(eq(dashboards.id, "dash-legacy"))

		await reshapeDashboardWidgets(db)
		const [second] = await db
			.select({ payloadJson: dashboards.payloadJson })
			.from(dashboards)
			.where(eq(dashboards.id, "dash-legacy"))

		expect(second!.payloadJson).toBe(first!.payloadJson)
	})
})
