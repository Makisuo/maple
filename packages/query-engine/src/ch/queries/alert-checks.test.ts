import { describe, expect, it } from "vitest"
import { compileCH } from "../compile"
import { listRuleChecksQuery } from "./alert-checks"

const baseParams = {
  orgId: "org_1",
  ruleId: "rule_1",
}

describe("listRuleChecksQuery", () => {
  it("compiles the minimal query with OrgId + RuleId", () => {
    const q = listRuleChecksQuery({ limit: 500 })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM alert_checks")
    expect(sql).toContain("formatDateTime(Timestamp, '%Y-%m-%dT%H:%i:%S.%fZ') AS timestamp")
    expect(sql).toContain("formatDateTime(WindowStart, '%Y-%m-%dT%H:%i:%S.%fZ') AS windowStart")
    expect(sql).toContain("formatDateTime(WindowEnd, '%Y-%m-%dT%H:%i:%S.%fZ') AS windowEnd")
    expect(sql).toContain("OrgId = 'org_1'")
    expect(sql).toContain("RuleId = 'rule_1'")
    expect(sql).toContain("ORDER BY timestamp DESC")
    expect(sql).toContain("LIMIT 500")
    expect(sql).toContain("FORMAT JSON")
    // No optional filters present
    expect(sql).not.toContain("GroupKey =")
    expect(sql).not.toContain("Timestamp >=")
    expect(sql).not.toContain("Timestamp <=")
  })

  it("applies groupKey filter when provided", () => {
    const q = listRuleChecksQuery({ limit: 100, groupKey: "svc=api" })
    const { sql } = compileCH(q, { ...baseParams, groupKey: "svc=api" })
    expect(sql).toContain("GroupKey = 'svc=api'")
  })

  it("omits groupKey filter when empty string", () => {
    const q = listRuleChecksQuery({ limit: 100, groupKey: "" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).not.toContain("GroupKey =")
  })

  it("applies since/until filters when provided", () => {
    const q = listRuleChecksQuery({
      limit: 100,
      since: "2024-01-01 00:00:00.000",
      until: "2024-01-02 00:00:00.000",
    })
    const { sql } = compileCH(q, {
      ...baseParams,
      since: "2024-01-01 00:00:00.000",
      until: "2024-01-02 00:00:00.000",
    })
    expect(sql).toContain("Timestamp >= '2024-01-01 00:00:00.000'")
    expect(sql).toContain("Timestamp <= '2024-01-02 00:00:00.000'")
  })

  it("escapes single quotes in orgId", () => {
    const q = listRuleChecksQuery({ limit: 10 })
    const { sql } = compileCH(q, { orgId: "org'evil", ruleId: "rule_1" })
    expect(sql).toContain("OrgId = 'org\\'evil'")
  })

  it("respects the limit argument", () => {
    const q = listRuleChecksQuery({ limit: 42 })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("LIMIT 42")
  })
})
