import { describe, expect, it } from "vitest"
import {
	backfillSQL,
	dropSQL,
	LOGS_VARIANTS,
	readInOrderProbeSQL,
	shadowTableDDL,
	TRACES_VARIANTS,
} from "./sortkey-variants"
import { dayWindows, emitSpikeSql } from "./emit-spike-sql"

const t2 = TRACES_VARIANTS.find((v) => v.name === "traces_t2")!
const l1 = LOGS_VARIANTS.find((v) => v.name === "logs_l1")!

describe("shadowTableDDL", () => {
	it("copies the base schema via AS and overrides the sort key", () => {
		const ddl = shadowTableDDL(t2)
		expect(ddl).toContain("CREATE TABLE IF NOT EXISTS traces_t2 AS traces")
		expect(ddl).toContain("PARTITION BY toDate(Timestamp)")
		expect(ddl).toContain(
			"ORDER BY (OrgId, toStartOfFiveMinutes(toDateTime(Timestamp)), ServiceName, toDateTime(Timestamp))",
		)
		// No TTL on throwaway shadow tables.
		expect(ddl).not.toContain("TTL")
	})

	it("keeps OrgId first in every candidate (multi-tenant scoping)", () => {
		for (const v of [...TRACES_VARIANTS, ...LOGS_VARIANTS]) {
			expect(v.orderBy.startsWith("(OrgId,"), `${v.name} must start with OrgId`).toBe(true)
		}
	})
})

describe("backfillSQL", () => {
	it("windows on the variant's ts column and escapes the org id", () => {
		const sql = backfillSQL(t2, { orgId: "org_x", startInclusive: "2026-01-07 00:00:00", endExclusive: "2026-01-08 00:00:00" })
		expect(sql).toContain("INSERT INTO traces_t2")
		expect(sql).toContain("SELECT * FROM traces")
		expect(sql).toContain("OrgId = 'org_x'")
		expect(sql).toContain("Timestamp >= toDateTime('2026-01-07 00:00:00')")
		expect(sql).toContain("Timestamp <  toDateTime('2026-01-08 00:00:00')")
	})

	it("uses TimestampTime for logs variants", () => {
		const sql = backfillSQL(l1, { orgId: "o", startInclusive: "2026-01-07 00:00:00", endExclusive: "2026-01-08 00:00:00" })
		expect(sql).toContain("TimestampTime >= toDateTime(")
	})
})

describe("readInOrderProbeSQL / dropSQL", () => {
	it("probes ORDER BY <ts> DESC with EXPLAIN indexes", () => {
		const sql = readInOrderProbeSQL(t2, { orgId: "org_x", limit: 25 })
		expect(sql).toContain("EXPLAIN actions = 1, indexes = 1")
		expect(sql).toContain("ORDER BY Timestamp DESC")
		expect(sql).toContain("LIMIT 25")
	})

	it("drops shadow tables idempotently", () => {
		expect(dropSQL(t2)).toBe("DROP TABLE IF EXISTS traces_t2")
	})
})

describe("dayWindows", () => {
	it("produces N contiguous 1-day windows, most-recent first", () => {
		const windows = dayWindows("2026-01-08 00:00:00", 3)
		expect(windows).toEqual([
			{ start: "2026-01-07 00:00:00", end: "2026-01-08 00:00:00" },
			{ start: "2026-01-06 00:00:00", end: "2026-01-07 00:00:00" },
			{ start: "2026-01-05 00:00:00", end: "2026-01-06 00:00:00" },
		])
	})
})

describe("emitSpikeSql", () => {
	it("setup emits a CREATE per variant", () => {
		const sql = emitSpikeSql({ org: "", days: 7, end: "2026-01-08 00:00:00", tables: "traces", mode: "setup" })
		expect(sql).toContain("CREATE TABLE IF NOT EXISTS traces_t1 AS traces")
		expect(sql).toContain("CREATE TABLE IF NOT EXISTS traces_t2 AS traces")
		expect(sql).toContain("CREATE TABLE IF NOT EXISTS traces_t3 AS traces")
	})

	it("backfill emits one INSERT per day per variant", () => {
		const sql = emitSpikeSql({ org: "org_x", days: 2, end: "2026-01-08 00:00:00", tables: "traces", mode: "backfill" })
		// 3 traces variants × 2 days = 6 INSERTs.
		expect(sql.match(/INSERT INTO/g)).toHaveLength(6)
	})

	it("drop emits one DROP per variant across all tables", () => {
		const sql = emitSpikeSql({ org: "", days: 7, end: "2026-01-08 00:00:00", tables: "all", mode: "drop" })
		expect(sql.match(/DROP TABLE IF EXISTS/g)).toHaveLength(6)
	})
})
