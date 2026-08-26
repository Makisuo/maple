import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { compileUnsafe } from "@maple-dev/clickhouse-builder"
import {
	planetscaleBranchStorageRowSchema,
	planetscaleBranchStorageSQL,
	planetscaleStorageRowSchema,
	planetscaleStorageSQL,
} from "./planetscale-map"

const params = {
	orgId: "org_1",
	startTime: "2026-07-02 00:00:00.000",
	endTime: "2026-07-03 00:00:00.000",
}

describe("planetscaleStorageSQL", () => {
	it("derives the used ratio per branch before rolling up to the database", () => {
		const { sql } = compileUnsafe(planetscaleStorageSQL(), params)
		// The inner grouping must carry `branch`, otherwise a database's max capacity
		// and min free space can come from two different branches and produce a
		// percentage neither branch ever had.
		expect(sql).toContain("GROUP BY database, branch")
		expect(sql).toContain("GROUP BY database")
		expect(sql).toContain("planetscale_volume_capacity_bytes")
		expect(sql).toContain("planetscale_volume_available_bytes")
		expect(sql).toContain("FORMAT JSON")
	})

	it("guards the ratio against zero capacity and an absent free-space series", () => {
		const { sql } = compileUnsafe(planetscaleStorageSQL(), params)
		expect(sql).toContain("capacityBytes > 0")
		expect(sql).toContain("samples > 0")
	})

	it("phrases the ratio so SQL precedence yields used-percent", () => {
		const { sql } = compileUnsafe(planetscaleStorageSQL(), params)
		// The builder's arithmetic helpers don't parenthesize, so the intuitive
		// `(capacity - available) / capacity * 100` would compile to
		// `capacity - available / capacity * 100` — a byte count, not a percentage.
		// Subtracting free space from 100 is correct without parens.
		expect(sql).toContain("100 - availableBytes / capacityBytes * 100")
		expect(sql).not.toContain("capacityBytes - availableBytes / capacityBytes")
	})

	it("scopes to the org", () => {
		const { sql } = compileUnsafe(planetscaleStorageSQL(), params)
		expect(sql).toContain("OrgId = 'org_1'")
	})

	it("decodes 64-bit byte counts arriving as strings", () => {
		const compiled = compileUnsafe(planetscaleStorageSQL(), params, {
			rowSchema: planetscaleStorageRowSchema,
		})
		expect(
			Effect.runSync(
				compiled.decodeRows([
					{ database: "maple", storageUsedPercent: "93.8", storageSamples: "2741" },
				]),
			),
		).toEqual([{ database: "maple", storageUsedPercent: 93.8, storageSamples: 2741 }])
	})
})

describe("planetscaleBranchStorageSQL", () => {
	it("filters to one database and keeps the raw byte counts", () => {
		const { sql } = compileUnsafe(planetscaleBranchStorageSQL(), { ...params, database: "maple" })
		expect(sql).toContain(
			"coalesce(nullIf(Attributes['planetscale_database_name'], ''), Attributes['planetscale_database']) = 'maple'",
		)
		expect(sql).toContain("GROUP BY database, branch")
		expect(sql).toContain("FORMAT JSON")
	})

	it("decodes a branch row", () => {
		const compiled = compileUnsafe(
			planetscaleBranchStorageSQL(),
			{ ...params, database: "maple" },
			{ rowSchema: planetscaleBranchStorageRowSchema },
		)
		expect(
			Effect.runSync(
				compiled.decodeRows([
					{
						database: "maple",
						branch: "pr-246",
						storageUsedPercent: "93.8",
						storageCapacityBytes: "41875931136",
						storageAvailableBytes: "2602532864",
						storageSamples: "2741",
					},
				]),
			),
		).toEqual([
			{
				database: "maple",
				branch: "pr-246",
				storageUsedPercent: 93.8,
				storageCapacityBytes: 41875931136,
				storageAvailableBytes: 2602532864,
				storageSamples: 2741,
			},
		])
	})
})
