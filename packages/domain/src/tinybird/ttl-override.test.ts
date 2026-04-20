import { describe, expect, it } from "vitest"
import {
  applyRawTtlOverrides,
  computeEffectiveRevision,
  EMPTY_TTL_OVERRIDES,
  type RawTableTtlOverrides,
} from "./ttl-override"

const rawLogs = {
  name: "logs",
  content: [
    'ENGINE "MergeTree"',
    'ENGINE_PARTITION_KEY "toDate(TimestampTime)"',
    'ENGINE_SORTING_KEY "OrgId, ServiceName, TimestampTime, Timestamp"',
    'ENGINE_TTL "toDate(TimestampTime) + INTERVAL 90 DAY"',
  ].join("\n"),
}

const rawTraces = {
  name: "traces",
  content: 'ENGINE "MergeTree"\nENGINE_TTL "toDate(Timestamp) + INTERVAL 90 DAY"',
}

const rawMetricsSum = {
  name: "metrics_sum",
  content: 'ENGINE "MergeTree"\nENGINE_TTL "toDate(TimeUnix) + INTERVAL 365 DAY"',
}

const mvServiceMap = {
  name: "service_map_spans",
  content: 'ENGINE "MergeTree"\nENGINE_TTL "Timestamp + INTERVAL 90 DAY"',
}

describe("applyRawTtlOverrides", () => {
  it("returns the original array when no overrides are set", () => {
    const input = [rawLogs, rawTraces, mvServiceMap]
    const result = applyRawTtlOverrides(input, EMPTY_TTL_OVERRIDES)
    expect(result).toBe(input)
  })

  it("rewrites the TTL interval for logs only when logsRetentionDays is set", () => {
    const result = applyRawTtlOverrides(
      [rawLogs, rawTraces, mvServiceMap],
      { ...EMPTY_TTL_OVERRIDES, logsRetentionDays: 30 },
    )
    const logs = result.find((r) => r.name === "logs")
    const traces = result.find((r) => r.name === "traces")
    const mv = result.find((r) => r.name === "service_map_spans")
    expect(logs?.content).toContain("INTERVAL 30 DAY")
    expect(logs?.content).not.toContain("INTERVAL 90 DAY")
    expect(traces?.content).toBe(rawTraces.content)
    expect(mv?.content).toBe(mvServiceMap.content)
  })

  it("rewrites all four raw metrics datasources when metricsRetentionDays is set", () => {
    const raws = ["metrics_sum", "metrics_gauge", "metrics_histogram", "metrics_exponential_histogram"].map(
      (name) => ({
        name,
        content: `ENGINE "MergeTree"\nENGINE_TTL "toDate(TimeUnix) + INTERVAL 365 DAY"`,
      }),
    )
    const result = applyRawTtlOverrides(raws, { ...EMPTY_TTL_OVERRIDES, metricsRetentionDays: 180 })
    for (const row of result) {
      expect(row.content).toContain("INTERVAL 180 DAY")
    }
  })

  it("leaves MV / derived datasources untouched", () => {
    const result = applyRawTtlOverrides(
      [mvServiceMap],
      { logsRetentionDays: 30, tracesRetentionDays: 30, metricsRetentionDays: 30 },
    )
    expect(result[0]?.content).toBe(mvServiceMap.content)
  })

  it("only touches the ENGINE_TTL clause, not similar substrings elsewhere", () => {
    const tricky = {
      name: "logs",
      content:
        'DESCRIPTION >\n    Retention INTERVAL 90 DAY mentioned in comments\n\nENGINE "MergeTree"\nENGINE_TTL "toDate(TimestampTime) + INTERVAL 90 DAY"',
    }
    const result = applyRawTtlOverrides([tricky], {
      ...EMPTY_TTL_OVERRIDES,
      logsRetentionDays: 45,
    })
    const content = result[0]!.content
    expect(content).toContain("Retention INTERVAL 90 DAY mentioned")
    expect(content).toContain('ENGINE_TTL "toDate(TimestampTime) + INTERVAL 45 DAY"')
  })
})

describe("computeEffectiveRevision", () => {
  const base = "abc123"

  it("returns the base revision unchanged when no overrides are set", () => {
    expect(computeEffectiveRevision(base, EMPTY_TTL_OVERRIDES)).toBe(base)
  })

  it("produces a stable revision for identical overrides", () => {
    const a: RawTableTtlOverrides = {
      logsRetentionDays: 30,
      tracesRetentionDays: 60,
      metricsRetentionDays: null,
    }
    const b: RawTableTtlOverrides = {
      logsRetentionDays: 30,
      tracesRetentionDays: 60,
      metricsRetentionDays: null,
    }
    expect(computeEffectiveRevision(base, a)).toBe(computeEffectiveRevision(base, b))
  })

  it("changes when any single field changes", () => {
    const a = computeEffectiveRevision(base, { ...EMPTY_TTL_OVERRIDES, logsRetentionDays: 30 })
    const b = computeEffectiveRevision(base, { ...EMPTY_TTL_OVERRIDES, logsRetentionDays: 31 })
    const c = computeEffectiveRevision(base, { ...EMPTY_TTL_OVERRIDES, tracesRetentionDays: 30 })
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
    expect(b).not.toBe(c)
  })

  it("differs from the base revision as soon as any override is set", () => {
    const r = computeEffectiveRevision(base, { ...EMPTY_TTL_OVERRIDES, metricsRetentionDays: 180 })
    expect(r).not.toBe(base)
    expect(r.startsWith(`${base}:`)).toBe(true)
  })
})
