import { describe, expect, it } from "vitest"
import * as schema from "@maple/db"
import { getTableColumns, is, Table } from "drizzle-orm"
import { ORG_DELETE_REGISTRY } from "./OrganizationService"

/**
 * The fix that stays fixed: org deletion missed four credential tables because
 * nothing connected "this table has an `org_id`" to "someone decided what
 * happens to it when the org dies". This test is that connection. A new
 * org-scoped table must be purged, purged by `approved_org_id`, or explicitly
 * named as deliberately kept — never simply forgotten.
 */

const ORG_COLUMN_NAMES = new Set(["org_id", "approved_org_id"])

const orgScopedTables = () => {
	const found = new Map<string, string>()
	for (const [exportName, value] of Object.entries(schema)) {
		if (!is(value, Table)) continue
		const columns = getTableColumns(value)
		for (const column of Object.values(columns)) {
			if (ORG_COLUMN_NAMES.has(column.name)) {
				found.set(exportName, column.name)
				break
			}
		}
	}
	return found
}

const registeredNames = (tables: ReadonlyArray<unknown>) => {
	const byTable = new Map<unknown, string>()
	for (const [exportName, value] of Object.entries(schema)) {
		if (is(value, Table)) byTable.set(value, exportName)
	}
	return tables.map((table) => byTable.get(table) ?? "<unexported table>")
}

describe("org-scoped table registry", () => {
	it("classifies every table that carries an org column", () => {
		const classified = new Set<string>([
			...registeredNames(ORG_DELETE_REGISTRY.orgScoped),
			...registeredNames(ORG_DELETE_REGISTRY.approvedOrgScoped),
			...ORG_DELETE_REGISTRY.unpurged,
		])
		const unclassified = [...orgScopedTables().keys()].filter((name) => !classified.has(name)).sort()
		expect(
			unclassified,
			"Every org-scoped table must be registered in OrganizationService: add it to ORG_SCOPED_TABLES (purged by org_id), APPROVED_ORG_SCOPED_TABLES (purged by approved_org_id), or UNPURGED_ORG_SCOPED_TABLES (deliberately kept).",
		).toEqual([])
	})

	it("registers nothing that no longer carries an org column", () => {
		const scoped = orgScopedTables()
		const stale = [
			...registeredNames(ORG_DELETE_REGISTRY.orgScoped),
			...registeredNames(ORG_DELETE_REGISTRY.approvedOrgScoped),
			...ORG_DELETE_REGISTRY.unpurged,
		]
			.filter((name) => !scoped.has(name))
			.sort()
		expect(stale).toEqual([])
	})

	it("purges each table by the column it actually has", () => {
		const scoped = orgScopedTables()
		for (const name of registeredNames(ORG_DELETE_REGISTRY.orgScoped)) {
			expect(scoped.get(name), `${name} is purged by org_id`).toBe("org_id")
		}
		for (const name of registeredNames(ORG_DELETE_REGISTRY.approvedOrgScoped)) {
			expect(scoped.get(name), `${name} is purged by approved_org_id`).toBe("approved_org_id")
		}
	})

	it("purges the credential tables that outlive a deleted org", () => {
		const purged = new Set([
			...registeredNames(ORG_DELETE_REGISTRY.orgScoped),
			...registeredNames(ORG_DELETE_REGISTRY.approvedOrgScoped),
		])
		for (const name of [
			"apiKeys",
			"mcpOAuthRefreshTokens",
			"mcpOAuthAuthorizations",
			"cliDeviceAuthorizations",
			"mobileDevices",
			// Public bearer token, encrypted inbound-webhook HMAC secret, and live
			// APNs push tokens respectively — all resolvable after the org is gone.
			"dashboardShares",
			"planetscaleConnections",
			"liveActivities",
		]) {
			expect(purged.has(name), `${name} must be purged on org deletion`).toBe(true)
		}
	})
})
