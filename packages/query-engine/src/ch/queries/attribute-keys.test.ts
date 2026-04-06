import { describe, expect, it } from "bun:test"
import { compileCH } from "../compile"
import {
  attributeKeysQuery,
  spanAttributeValuesQuery,
  resourceAttributeValuesQuery,
} from "./attribute-keys"

const baseParams = {
  orgId: "org_1",
  startTime: "2024-01-01 00:00:00",
  endTime: "2024-01-02 00:00:00",
  scope: "span",
}

// ---------------------------------------------------------------------------
// attributeKeysQuery
// ---------------------------------------------------------------------------

describe("attributeKeysQuery", () => {
  it("compiles basic attribute keys query", () => {
    const q = attributeKeysQuery({ scope: "span" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM attribute_keys_hourly")
    expect(sql).toContain("AttributeKey AS attributeKey")
    expect(sql).toContain("sum(UsageCount) AS usageCount")
    expect(sql).toContain("GROUP BY attributeKey")
    expect(sql).toContain("ORDER BY usageCount DESC")
    expect(sql).toContain("LIMIT 200")
    expect(sql).toContain("FORMAT JSON")
  })

  it("applies custom limit", () => {
    const q = attributeKeysQuery({ scope: "resource", limit: 50 })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("LIMIT 50")
  })
})

// ---------------------------------------------------------------------------
// spanAttributeValuesQuery
// ---------------------------------------------------------------------------

describe("spanAttributeValuesQuery", () => {
  it("compiles span attribute values", () => {
    const q = spanAttributeValuesQuery({ attributeKey: "http.method" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM traces")
    expect(sql).toContain("SpanAttributes['http.method'] AS attributeValue")
    expect(sql).toContain("count() AS usageCount")
    expect(sql).toContain("SpanAttributes['http.method'] != ''")
    expect(sql).toContain("GROUP BY attributeValue")
    expect(sql).toContain("ORDER BY usageCount DESC")
    expect(sql).toContain("LIMIT 50")
    expect(sql).toContain("FORMAT JSON")
  })

  it("applies custom limit", () => {
    const q = spanAttributeValuesQuery({ attributeKey: "http.method", limit: 100 })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("LIMIT 100")
  })
})

// ---------------------------------------------------------------------------
// resourceAttributeValuesQuery
// ---------------------------------------------------------------------------

describe("resourceAttributeValuesQuery", () => {
  it("compiles resource attribute values", () => {
    const q = resourceAttributeValuesQuery({ attributeKey: "host.name" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM traces")
    expect(sql).toContain("ResourceAttributes['host.name'] AS attributeValue")
    expect(sql).toContain("ResourceAttributes['host.name'] != ''")
    expect(sql).toContain("GROUP BY attributeValue")
    expect(sql).toContain("ORDER BY usageCount DESC")
  })
})
