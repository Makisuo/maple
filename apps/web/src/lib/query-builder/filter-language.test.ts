import { describe, expect, it } from "vitest"
import { QueryBuilderParseError, parseFilterExpression } from "@/lib/query-builder/filter-language"

describe("filter-language parser", () => {
  it("parses nested boolean groups", () => {
    const parsed = parseFilterExpression(
      `service.name = "api" AND (attr.http.route = "/users" OR resource.region = "us-east-1")`,
    )

    expect(parsed).toEqual({
      kind: "group",
      operator: "AND",
      clauses: [
        {
          kind: "comparison",
          field: "service.name",
          operator: "=",
          value: "api",
        },
        {
          kind: "group",
          operator: "OR",
          clauses: [
            {
              kind: "comparison",
              field: "attr.http.route",
              operator: "=",
              value: "/users",
            },
            {
              kind: "comparison",
              field: "resource.region",
              operator: "=",
              value: "us-east-1",
            },
          ],
        },
      ],
    })
  })

  it("parses IN and EXISTS operators", () => {
    const parsed = parseFilterExpression(
      `severity IN ("error", "warn") AND attr.request_id EXISTS`,
    )

    expect(parsed).toEqual({
      kind: "group",
      operator: "AND",
      clauses: [
        {
          kind: "comparison",
          field: "severity",
          operator: "IN",
          value: ["error", "warn"],
        },
        {
          kind: "exists",
          field: "attr.request_id",
        },
      ],
    })
  })

  it("throws on invalid syntax", () => {
    expect(() => parseFilterExpression(`service.name = "api" AND (`)).toThrow(
      QueryBuilderParseError,
    )
  })
})
