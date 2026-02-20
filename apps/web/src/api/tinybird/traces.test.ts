import { beforeEach, describe, expect, it, vi } from "vitest"
import { Effect } from "effect"

const tinybirdQueryMocks = {
  list_traces: vi.fn(() => Effect.succeed({ data: [] })),
  traces_facets: vi.fn(() => Effect.succeed({ data: [] })),
  traces_duration_stats: vi.fn(() => Effect.succeed({ data: [] })),
  span_hierarchy: vi.fn(() => Effect.succeed({ data: [] })),
  span_attribute_keys: vi.fn(() => Effect.succeed({ data: [] })),
  span_attribute_values: vi.fn(() => Effect.succeed({ data: [] })),
}

vi.mock("@/lib/tinybird", () => ({
  getTinybird: () => ({ query: tinybirdQueryMocks }),
}))

import {
  getTracesDurationStats,
  getTracesFacets,
  listTraces,
} from "@/api/tinybird/traces"

describe("tinybird traces attribute filter params", () => {
  beforeEach(() => {
    for (const mock of Object.values(tinybirdQueryMocks)) {
      mock.mockClear()
    }
  })

  it("forwards attribute filter params to list_traces", async () => {
    await Effect.runPromise(
      listTraces({
        data: {
          startTime: "2026-02-01 00:00:00",
          endTime: "2026-02-01 01:00:00",
          attributeKey: "http.route",
          attributeValue: "/checkout",
        },
      }),
    )

    expect(tinybirdQueryMocks.list_traces).toHaveBeenCalledWith(
      expect.objectContaining({
        attribute_filter_key: "http.route",
        attribute_filter_value: "/checkout",
      }),
    )
  })

  it("forwards attribute filter params to traces_facets and traces_duration_stats", async () => {
    await Effect.runPromise(
      getTracesFacets({
        data: {
          startTime: "2026-02-01 00:00:00",
          endTime: "2026-02-01 01:00:00",
          attributeKey: "http.route",
          attributeValue: "/checkout",
        },
      }),
    )

    expect(tinybirdQueryMocks.traces_facets).toHaveBeenCalledWith(
      expect.objectContaining({
        attribute_filter_key: "http.route",
        attribute_filter_value: "/checkout",
      }),
    )
    expect(tinybirdQueryMocks.traces_duration_stats).toHaveBeenCalledWith(
      expect.objectContaining({
        attribute_filter_key: "http.route",
        attribute_filter_value: "/checkout",
      }),
    )
  })

  it("forwards attribute filter params to standalone traces_duration_stats", async () => {
    await Effect.runPromise(
      getTracesDurationStats({
        data: {
          startTime: "2026-02-01 00:00:00",
          endTime: "2026-02-01 01:00:00",
          attributeKey: "http.route",
          attributeValue: "/checkout",
        },
      }),
    )

    expect(tinybirdQueryMocks.traces_duration_stats).toHaveBeenCalledWith(
      expect.objectContaining({
        attribute_filter_key: "http.route",
        attribute_filter_value: "/checkout",
      }),
    )
  })
})
