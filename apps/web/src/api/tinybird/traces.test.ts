import { beforeEach, describe, expect, it, vi } from "vitest"
import { Effect } from "effect"

const tinybirdQueryMocks = {
  list_traces: vi.fn<() => Effect.Effect<{ data: Array<Record<string, unknown>> }, never, never>>(
    () => Effect.succeed({ data: [] }),
  ),
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

  it("forwards basic filter params to list_traces", async () => {
    await Effect.runPromise(
      listTraces({
        data: {
          startTime: "2026-02-01 00:00:00",
          endTime: "2026-02-01 01:00:00",
        },
      }),
    )

    expect(tinybirdQueryMocks.list_traces).toHaveBeenCalledWith(
      expect.objectContaining({
        start_time: "2026-02-01 00:00:00",
        end_time: "2026-02-01 01:00:00",
      }),
    )
  })

  it("forwards filter params to traces_facets and traces_duration_stats", async () => {
    await Effect.runPromise(
      getTracesFacets({
        data: {
          startTime: "2026-02-01 00:00:00",
          endTime: "2026-02-01 01:00:00",
        },
      }),
    )

    expect(tinybirdQueryMocks.traces_facets).toHaveBeenCalledWith(
      expect.objectContaining({
        start_time: "2026-02-01 00:00:00",
        end_time: "2026-02-01 01:00:00",
      }),
    )
    expect(tinybirdQueryMocks.traces_duration_stats).toHaveBeenCalledWith(
      expect.objectContaining({
        start_time: "2026-02-01 00:00:00",
        end_time: "2026-02-01 01:00:00",
      }),
    )
  })

  it("forwards filter params to standalone traces_duration_stats", async () => {
    await Effect.runPromise(
      getTracesDurationStats({
        data: {
          startTime: "2026-02-01 00:00:00",
          endTime: "2026-02-01 01:00:00",
        },
      }),
    )

    expect(tinybirdQueryMocks.traces_duration_stats).toHaveBeenCalledWith(
      expect.objectContaining({
        start_time: "2026-02-01 00:00:00",
        end_time: "2026-02-01 01:00:00",
      }),
    )
  })

  it("builds a curated rootSpan summary for overview rows", async () => {
    tinybirdQueryMocks.list_traces.mockReturnValueOnce(
      Effect.succeed({
        data: [{
          traceId: "trace-1",
          startTime: "2026-02-01 00:00:00",
          endTime: "2026-02-01 00:00:02",
          durationMicros: 2000000,
          spanCount: 3,
          services: ["checkout", "payments"],
          rootSpanName: "GET",
          rootSpanKind: "SPAN_KIND_SERVER",
          rootSpanStatusCode: "Ok",
          rootHttpMethod: "GET",
          rootHttpRoute: "/checkout",
          rootHttpStatusCode: "200",
          hasError: 0,
        }],
      } as { data: Array<Record<string, unknown>> }),
    )

    const response = await Effect.runPromise(
      listTraces({
        data: {
          startTime: "2026-02-01 00:00:00",
          endTime: "2026-02-01 01:00:00",
        },
      }),
    )

    expect(response.data[0]).toMatchObject({
      rootSpanName: "GET",
      rootSpan: {
        name: "GET",
        kind: "SPAN_KIND_SERVER",
        statusCode: "Ok",
        attributes: {
          "http.method": "GET",
          "http.route": "/checkout",
          "http.status_code": "200",
        },
        http: {
          method: "GET",
          route: "/checkout",
          statusCode: 200,
          isError: false,
        },
      },
    })
  })
})
