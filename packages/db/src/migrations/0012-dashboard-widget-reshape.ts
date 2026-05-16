// ---------------------------------------------------------------------------
// Data migration 0012 — reshape stored dashboards to the source-discriminated
// widget shape (see reshapeDashboardDocumentV2 in @maple/domain).
//
// Rewrites every `dashboards.payloadJson` and `dashboardVersions.snapshotJson`
// row. Idempotent and guarded by the `_maple_data_migrations` bookkeeping table,
// so it is safe to invoke on every libSQL startup and every D1 worker boot.
// ---------------------------------------------------------------------------

import { reshapeDashboardDocumentV2 } from "@maple/domain/http"
import { and, eq, sql } from "drizzle-orm"
import type { MapleLibsqlClient } from "../client"
import { dashboards, dashboardVersions } from "../schema"

const MIGRATION_ID = "0012-dashboard-widget-reshape"

function reshapeJson(json: string, label: string): string {
	let parsed: unknown
	try {
		parsed = JSON.parse(json)
	} catch (cause) {
		throw new Error(`[migration ${MIGRATION_ID}] invalid JSON for ${label}`, { cause })
	}
	return JSON.stringify(reshapeDashboardDocumentV2(parsed))
}

export async function reshapeDashboardWidgets(db: MapleLibsqlClient): Promise<void> {
	await db.run(
		sql`CREATE TABLE IF NOT EXISTS _maple_data_migrations (id text PRIMARY KEY, applied_at integer NOT NULL)`,
	)

	const applied = await db.all(sql`SELECT id FROM _maple_data_migrations WHERE id = ${MIGRATION_ID}`)
	if (applied.length > 0) return

	const dashboardRows = await db
		.select({ orgId: dashboards.orgId, id: dashboards.id, payloadJson: dashboards.payloadJson })
		.from(dashboards)

	for (const row of dashboardRows) {
		const reshaped = reshapeJson(row.payloadJson, `dashboards ${row.orgId}/${row.id}`)
		if (reshaped !== row.payloadJson) {
			await db
				.update(dashboards)
				.set({ payloadJson: reshaped })
				.where(and(eq(dashboards.orgId, row.orgId), eq(dashboards.id, row.id)))
		}
	}

	const versionRows = await db
		.select({
			orgId: dashboardVersions.orgId,
			id: dashboardVersions.id,
			snapshotJson: dashboardVersions.snapshotJson,
		})
		.from(dashboardVersions)

	for (const row of versionRows) {
		const reshaped = reshapeJson(row.snapshotJson, `dashboard_versions ${row.orgId}/${row.id}`)
		if (reshaped !== row.snapshotJson) {
			await db
				.update(dashboardVersions)
				.set({ snapshotJson: reshaped })
				.where(and(eq(dashboardVersions.orgId, row.orgId), eq(dashboardVersions.id, row.id)))
		}
	}

	await db.run(
		sql`INSERT INTO _maple_data_migrations (id, applied_at) VALUES (${MIGRATION_ID}, ${Date.now()})`,
	)
}
