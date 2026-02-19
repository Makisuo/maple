import { beforeEach, describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import {
  getCustomChartServiceDetail,
  getCustomChartServiceSparklines,
  getOverviewTimeSeries,
} from "@/api/tinybird/custom-charts"
import { getServiceApdexTimeSeries } from "@/api/tinybird/services"

const customTracesTimeseriesMock = vi.fn()
const serviceApdexTimeseriesMock = vi.fn()

vi.mock("@/lib/tinybird", () => ({
  getTinybird: () => ({
    query: {
      custom_traces_timeseries: customTracesTimeseriesMock,
      service_apdex_time_series: serviceApdexTimeseriesMock,
    },
  }),
}))

describe("timeseries adapters", () => {
  beforeEach(() => {
    customTracesTimeseriesMock.mockReset()
    serviceApdexTimeseriesMock.mockReset()
  })

  it("fills overview/detail buckets without flattening existing points", async () => {
    customTracesTimeseriesMock.mockReturnValue(Effect.succeed({
      data: [
        {
          bucket: "2026-01-01 00:00:00",
          groupName: "all",
          count: 10,
          errorRate: 2,
          p50Duration: 11,
          p95Duration: 20,
          p99Duration: 30,
        },
      ],
    }))

    const overview = await Effect.runPromise(getOverviewTimeSeries({
      data: {
        startTime: "2026-01-01 00:00:00",
        endTime: "2026-01-01 00:05:00",
      },
    }))
    const detail = await Effect.runPromise(getCustomChartServiceDetail({
      data: {
        serviceName: "checkout",
        startTime: "2026-01-01 00:00:00",
        endTime: "2026-01-01 00:05:00",
      },
    }))

    expect(overview.data).toHaveLength(6)
    expect(detail.data).toHaveLength(6)
    expect(overview.data[0]).toMatchObject({
      bucket: "2026-01-01T00:00:00.000Z",
      throughput: 10,
      errorRate: 2,
    })
    expect(overview.data[1]).toMatchObject({
      bucket: "2026-01-01T00:01:00.000Z",
      throughput: 0,
      errorRate: 0,
    })
    expect(detail.data[0]).toMatchObject({
      bucket: "2026-01-01T00:00:00.000Z",
      throughput: 10,
      p95LatencyMs: 20,
    })
  })

  it("fills service sparklines per service across the selected timeline", async () => {
    customTracesTimeseriesMock.mockReturnValue(Effect.succeed({
      data: [
        {
          bucket: "2026-01-01 00:00:00",
          groupName: "checkout",
          count: 3,
          errorRate: 1,
        },
        {
          bucket: "2026-01-01 00:02:00",
          groupName: "checkout",
          count: 5,
          errorRate: 0,
        },
      ],
    }))

    const response = await Effect.runPromise(getCustomChartServiceSparklines({
      data: {
        startTime: "2026-01-01 00:00:00",
        endTime: "2026-01-01 00:02:00",
      },
    }))

    expect(response.data.checkout).toHaveLength(3)
    expect(response.data.checkout[0]).toMatchObject({
      bucket: "2026-01-01T00:00:00.000Z",
      throughput: 3,
      errorRate: 1,
    })
    expect(response.data.checkout[1]).toMatchObject({
      bucket: "2026-01-01T00:01:00.000Z",
      throughput: 0,
      errorRate: 0,
    })
    expect(response.data.checkout[2]).toMatchObject({
      bucket: "2026-01-01T00:02:00.000Z",
      throughput: 5,
      errorRate: 0,
    })
  })

  it("fills service apdex buckets while preserving real values", async () => {
    serviceApdexTimeseriesMock.mockReturnValue(Effect.succeed({
      data: [
        {
          bucket: "2026-01-01 00:00:00",
          apdexScore: 0.91,
          totalCount: 100,
        },
      ],
    }))

    const response = await Effect.runPromise(getServiceApdexTimeSeries({
      data: {
        serviceName: "checkout",
        startTime: "2026-01-01 00:00:00",
        endTime: "2026-01-01 00:05:00",
      },
    }))

    expect(response.data).toHaveLength(6)
    expect(response.data[0]).toMatchObject({
      bucket: "2026-01-01T00:00:00.000Z",
      apdexScore: 0.91,
      totalCount: 100,
    })
    expect(response.data[5]).toMatchObject({
      bucket: "2026-01-01T00:05:00.000Z",
      apdexScore: 0,
      totalCount: 0,
    })
  })
})
