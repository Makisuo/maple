import { describe, expect, it } from "vitest"

import {
  applyWhereClause,
  parseWhereClause,
  toWhereClause,
} from "@/lib/traces/advanced-filter-sync"

describe("parseWhereClause", () => {
  it("parses service.name", () => {
    const { filters } = parseWhereClause('service.name = "checkout"')
    expect(filters.service).toBe("checkout")
  })

  it("parses service alias", () => {
    const { filters } = parseWhereClause('service = "checkout"')
    expect(filters.service).toBe("checkout")
  })

  it("parses span.name", () => {
    const { filters } = parseWhereClause('span.name = "GET /orders"')
    expect(filters.spanName).toBe("GET /orders")
  })

  it("parses deployment.environment and aliases", () => {
    expect(parseWhereClause('deployment.environment = "production"').filters.deploymentEnv).toBe("production")
    expect(parseWhereClause('environment = "staging"').filters.deploymentEnv).toBe("staging")
    expect(parseWhereClause('env = "dev"').filters.deploymentEnv).toBe("dev")
  })

  it("parses http.method and http.status_code", () => {
    const { filters } = parseWhereClause('http.method = "POST" AND http.status_code = "404"')
    expect(filters.httpMethod).toBe("POST")
    expect(filters.httpStatusCode).toBe("404")
  })

  it("parses has_error = true", () => {
    const { filters } = parseWhereClause("has_error = true")
    expect(filters.hasError).toBe(true)
  })

  it("drops has_error = false", () => {
    const { filters } = parseWhereClause("has_error = false")
    expect(filters.hasError).toBeUndefined()
  })

  it("parses root_only = false", () => {
    const { filters } = parseWhereClause("root_only = false")
    expect(filters.rootOnly).toBe(false)
  })

  it("drops root_only = true", () => {
    const { filters } = parseWhereClause("root_only = true")
    expect(filters.rootOnly).toBeUndefined()
  })

  it("parses duration bounds", () => {
    const { filters } = parseWhereClause("min_duration_ms = 25 AND max_duration_ms = 1500")
    expect(filters.minDurationMs).toBe(25)
    expect(filters.maxDurationMs).toBe(1500)
  })

  it("parses attr.* keys", () => {
    const { filters } = parseWhereClause('attr.http.route = "/orders/:id"')
    expect(filters.attributeKey).toBe("http.route")
    expect(filters.attributeValue).toBe("/orders/:id")
  })

  it("marks incomplete clauses for unclosed quotes", () => {
    const result = parseWhereClause('service.name = "check')
    expect(result.hasIncompleteClauses).toBe(true)
  })

  it("marks invalid number as incomplete", () => {
    const result = parseWhereClause("min_duration_ms = nope")
    expect(result.hasIncompleteClauses).toBe(true)
    expect(result.filters.minDurationMs).toBeUndefined()
  })

  it("returns empty for empty input", () => {
    const result = parseWhereClause("")
    expect(result.filters).toEqual({})
    expect(result.hasIncompleteClauses).toBe(false)
  })

  it("parses a full combined clause", () => {
    const { filters } = parseWhereClause(
      'service = "checkout" AND span = "GET /orders" AND env = "production" AND http.method = "POST" AND http.status_code = "404" AND has_error = true AND root_only = false AND min_duration_ms = 12.5 AND max_duration_ms = 88 AND attr.http.route = "/api/orders"',
    )

    expect(filters.service).toBe("checkout")
    expect(filters.spanName).toBe("GET /orders")
    expect(filters.deploymentEnv).toBe("production")
    expect(filters.httpMethod).toBe("POST")
    expect(filters.httpStatusCode).toBe("404")
    expect(filters.hasError).toBe(true)
    expect(filters.rootOnly).toBe(false)
    expect(filters.minDurationMs).toBe(12.5)
    expect(filters.maxDurationMs).toBe(88)
    expect(filters.attributeKey).toBe("http.route")
    expect(filters.attributeValue).toBe("/api/orders")
  })
})

describe("toWhereClause", () => {
  it("builds a where clause from filters", () => {
    const clause = toWhereClause({
      service: "checkout",
      spanName: "GET /orders",
      hasError: true,
      minDurationMs: 25,
    })
    expect(clause).toBe(
      'service.name = "checkout" AND span.name = "GET /orders" AND has_error = true AND min_duration_ms = 25',
    )
  })

  it("returns undefined for empty filters", () => {
    expect(toWhereClause({})).toBeUndefined()
  })

  it("includes attr.* clauses", () => {
    const clause = toWhereClause({
      attributeKey: "http.route",
      attributeValue: "/orders/:id",
    })
    expect(clause).toBe('attr.http.route = "/orders/:id"')
  })
})

describe("applyWhereClause", () => {
  it("merges parsed values into search params", () => {
    const result = applyWhereClause(
      { startTime: "2026-02-01 00:00:00", endTime: "2026-02-01 01:00:00" },
      'service.name = "checkout" AND has_error = true',
    )

    expect(result.whereClause).toBe('service.name = "checkout" AND has_error = true')
    expect(result.services).toEqual(["checkout"])
    expect(result.hasError).toBe(true)
    expect(result.startTime).toBe("2026-02-01 00:00:00")
    expect(result.endTime).toBe("2026-02-01 01:00:00")
  })

  it("preserves existing search params when clause doesn't override them", () => {
    const result = applyWhereClause(
      {
        services: ["billing"],
        hasError: true,
        startTime: "2026-02-01 00:00:00",
      },
      'span.name = "POST /pay"',
    )

    expect(result.spanNames).toEqual(["POST /pay"])
    expect(result.services).toEqual(["billing"])
    expect(result.hasError).toBe(true)
  })

  it("overrides search params when clause includes them", () => {
    const result = applyWhereClause(
      { services: ["billing"] },
      'service.name = "checkout"',
    )

    expect(result.services).toEqual(["checkout"])
  })

  it("clears all filter params when clause is empty", () => {
    const result = applyWhereClause(
      {
        services: ["checkout"],
        hasError: true,
        minDurationMs: 100,
        startTime: "2026-02-01 00:00:00",
      },
      "",
    )

    expect(result.whereClause).toBeUndefined()
    expect(result.services).toBeUndefined()
    expect(result.hasError).toBeUndefined()
    expect(result.minDurationMs).toBeUndefined()
    expect(result.startTime).toBe("2026-02-01 00:00:00")
  })

  it("handles incomplete clauses gracefully", () => {
    const result = applyWhereClause(
      { services: ["billing"] },
      'service.name = "check',
    )

    expect(result.whereClause).toBe('service.name = "check')
    expect(result.services).toEqual(["billing"])
  })

  it("handles whitespace-only clause as empty", () => {
    const result = applyWhereClause(
      { services: ["checkout"] },
      "   ",
    )

    expect(result.whereClause).toBeUndefined()
    expect(result.services).toBeUndefined()
  })
})
