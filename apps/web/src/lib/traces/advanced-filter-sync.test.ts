import { describe, expect, it } from "vitest"

import {
  areTracesSearchParamsEqual,
  normalizeTracesSearchParams,
} from "@/lib/traces/advanced-filter-sync"

describe("advanced-filter-sync", () => {
  it("normalizes legacy filters into whereClause", () => {
    const normalized = normalizeTracesSearchParams({
      services: ["checkout", "billing"],
      spanNames: ["GET /orders"],
      deploymentEnvs: ["production"],
      httpMethods: ["GET"],
      httpStatusCodes: ["500"],
      hasError: true,
      rootOnly: false,
      minDurationMs: 25,
      maxDurationMs: 1500,
      attributeKey: "http.route",
      attributeValue: "/orders/:id",
      startTime: "2026-02-01 00:00:00",
      endTime: "2026-02-01 01:00:00",
    })

    expect(normalized.services).toEqual(["checkout"])
    expect(normalized.whereClause).toBe(
      'service.name = "checkout" AND span.name = "GET /orders" AND deployment.environment = "production" AND http.method = "GET" AND http.status_code = "500" AND has_error = true AND root_only = false AND min_duration_ms = 25 AND max_duration_ms = 1500 AND attr.http.route = "/orders/:id"',
    )
  })

  it("parses whereClause and populates legacy fields", () => {
    const normalized = normalizeTracesSearchParams({
      whereClause:
        'service = "checkout" AND span = "GET /orders" AND env = "production" AND http.method = "POST" AND http.status_code = "404" AND has_error = true AND root_only = false AND min_duration_ms = 12.5 AND max_duration_ms = 88 AND attr.http.route = "/api/orders"',
    })

    expect(normalized.services).toEqual(["checkout"])
    expect(normalized.spanNames).toEqual(["GET /orders"])
    expect(normalized.deploymentEnvs).toEqual(["production"])
    expect(normalized.httpMethods).toEqual(["POST"])
    expect(normalized.httpStatusCodes).toEqual(["404"])
    expect(normalized.hasError).toBe(true)
    expect(normalized.rootOnly).toBe(false)
    expect(normalized.minDurationMs).toBe(12.5)
    expect(normalized.maxDurationMs).toBe(88)
    expect(normalized.attributeKey).toBe("http.route")
    expect(normalized.attributeValue).toBe("/api/orders")
  })

  it("drops unsupported and non-functional clauses", () => {
    const normalized = normalizeTracesSearchParams({
      whereClause:
        'foo = "bar" AND has_error = false AND root_only = true AND min_duration_ms = nope AND attr.http.route = "/ok"',
    })

    expect(normalized.whereClause).toBe('attr.http.route = "/ok"')
    expect(normalized.hasError).toBeUndefined()
    expect(normalized.rootOnly).toBeUndefined()
    expect(normalized.minDurationMs).toBeUndefined()
    expect(normalized.attributeKey).toBe("http.route")
  })

  it("uses whereClause as precedence when both legacy and whereClause exist", () => {
    const normalized = normalizeTracesSearchParams({
      services: ["legacy"],
      whereClause: 'service.name = "from-where" AND has_error = true',
    })

    expect(normalized.services).toEqual(["from-where"])
    expect(normalized.hasError).toBe(true)
    expect(normalized.whereClause).toBe(
      'service.name = "from-where" AND has_error = true',
    )
  })

  it("normalizes empty results to undefined whereClause", () => {
    const normalized = normalizeTracesSearchParams({
      whereClause: 'has_error = false AND root_only = true',
    })

    expect(normalized.whereClause).toBeUndefined()
    expect(normalized.services).toBeUndefined()
    expect(normalized.attributeKey).toBeUndefined()
  })

  it("preserves incomplete whereClause text while editing", () => {
    const normalized = normalizeTracesSearchParams({
      whereClause: 'service.name = "check',
      services: ["legacy"],
    })

    expect(normalized.whereClause).toBe('service.name = "check')
    expect(normalized.services).toBeUndefined()
  })

  it("compares search params deterministically", () => {
    const left = normalizeTracesSearchParams({
      services: ["checkout"],
      startTime: "2026-02-01 00:00:00",
      endTime: "2026-02-01 01:00:00",
    })
    const right = normalizeTracesSearchParams({
      whereClause: 'service = "checkout"',
      startTime: "2026-02-01 00:00:00",
      endTime: "2026-02-01 01:00:00",
    })

    expect(areTracesSearchParamsEqual(left, right)).toBe(true)
  })
})
