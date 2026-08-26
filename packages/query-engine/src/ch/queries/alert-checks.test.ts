import { describe, expect, it } from "@effect/vitest"
import { compileUnsafe } from "@maple-dev/clickhouse-builder"
import { alertCheckGroupTotalsQuery, alertChecksSummaryQuery, listRuleChecksQuery } from "./alert-checks"

const baseParams = {
	orgId: "org_1",
	ruleId: "rule_1",
}

describe("listRuleChecksQuery", () => {
	it("compiles the minimal query with OrgId + RuleId", () => {
		const q = listRuleChecksQuery({ limit: 500 })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM alert_checks")
		expect(sql).toContain("formatDateTime(Timestamp, '%Y-%m-%dT%H:%i:%S.%fZ') AS timestamp")
		expect(sql).toContain("formatDateTime(WindowStart, '%Y-%m-%dT%H:%i:%S.%fZ') AS windowStart")
		expect(sql).toContain("formatDateTime(WindowEnd, '%Y-%m-%dT%H:%i:%S.%fZ') AS windowEnd")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("RuleId = 'rule_1'")
		expect(sql).toContain("ORDER BY timestamp DESC, groupKey ASC")
		expect(sql).toContain("LIMIT 500")
		expect(sql).toContain("FORMAT JSON")
		// No optional filters present
		expect(sql).not.toContain("GroupKey =")
		expect(sql).not.toContain("Timestamp >=")
		expect(sql).not.toContain("Timestamp <=")
	})

	it("applies groupKey filter when provided", () => {
		const q = listRuleChecksQuery({ limit: 100, groupKey: "svc=api" })
		const { sql } = compileUnsafe(q, { ...baseParams, groupKey: "svc=api" })
		expect(sql).toContain("GroupKey = 'svc=api'")
	})

	it("omits groupKey filter when empty string", () => {
		const q = listRuleChecksQuery({ limit: 100, groupKey: "" })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).not.toContain("GroupKey =")
	})

	it("applies since/until filters when provided", () => {
		const q = listRuleChecksQuery({
			limit: 100,
			since: "2024-01-01 00:00:00.000",
			until: "2024-01-02 00:00:00.000",
		})
		const { sql } = compileUnsafe(q, {
			...baseParams,
			since: "2024-01-01 00:00:00.000",
			until: "2024-01-02 00:00:00.000",
		})
		expect(sql).toContain("Timestamp >= '2024-01-01 00:00:00.000'")
		expect(sql).toContain("Timestamp <= '2024-01-02 00:00:00.000'")
	})

	it("escapes single quotes in orgId", () => {
		const q = listRuleChecksQuery({ limit: 10 })
		const { sql } = compileUnsafe(q, { orgId: "org'evil", ruleId: "rule_1" })
		expect(sql).toContain("OrgId = 'org\\'evil'")
	})

	it("applies status and the compound keyset cursor", () => {
		const q = listRuleChecksQuery({
			limit: 42,
			status: "breached",
			beforeTimestamp: "2024-01-02 03:04:05.000",
			beforeGroupKey: "svc=worker",
		})
		const { sql } = compileUnsafe(q, {
			...baseParams,
			status: "breached",
			beforeTimestamp: "2024-01-02 03:04:05.000",
			beforeGroupKey: "svc=worker",
		})
		expect(sql).toContain("LIMIT 42")
		expect(sql).toContain("Status = 'breached'")
		expect(sql).toContain("Timestamp < '2024-01-02 03:04:05.000'")
		expect(sql).toContain("GroupKey > 'svc=worker'")
		expect(sql).not.toContain("OFFSET")
	})
})

describe("alert history summaries", () => {
	it("limits the group-ranking query", () => {
		const { sql } = compileUnsafe(
			alertCheckGroupTotalsQuery({
				since: "2024-01-01 00:00:00",
				until: "2024-12-31 23:59:59",
				limit: 20,
			}),
			{
				...baseParams,
				since: "2024-01-01 00:00:00",
				until: "2024-12-31 23:59:59",
			},
		)
		expect(sql).toContain("GROUP BY groupKey")
		expect(sql).toContain("ORDER BY totalCount DESC")
		expect(sql).toContain("LIMIT 20")
	})

	it("buckets top groups and folds the remainder into other", () => {
		const { sql } = compileUnsafe(
			alertChecksSummaryQuery({
				topGroupKeys: ["svc=api", "svc=worker"],
			}),
			{
				...baseParams,
				since: "2024-01-01 00:00:00",
				until: "2024-12-31 23:59:59",
				bucketSeconds: 43_200,
			},
		)
		expect(sql).toContain("toStartOfInterval")
		expect(sql).toContain("43200")
		expect(sql).toContain("'__other__'")
		expect(sql).toContain("countIf")
	})
})
