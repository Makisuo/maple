import { describe, expect, it } from "vitest"
import {
  appendSettings,
  detectQuotaSetting,
  QueryProfile,
  resolveSettings,
} from "./TinybirdQueryProfile"

describe("appendSettings", () => {
  it("returns sql unchanged when settings are undefined", () => {
    expect(appendSettings("SELECT 1", undefined)).toBe("SELECT 1")
  })

  it("returns sql unchanged when settings are empty", () => {
    expect(appendSettings("SELECT 1", {})).toBe("SELECT 1")
  })

  it("appends a single setting", () => {
    expect(appendSettings("SELECT 1", { maxExecutionTime: 10 })).toBe(
      "SELECT 1 SETTINGS max_execution_time=10",
    )
  })

  it("appends multiple settings comma-separated", () => {
    expect(
      appendSettings("SELECT 1", {
        maxExecutionTime: 10,
        maxMemoryUsage: 1_000_000,
        maxThreads: 4,
      }),
    ).toBe("SELECT 1 SETTINGS max_execution_time=10, max_memory_usage=1000000, max_threads=4")
  })

  it("strips trailing semicolon before appending", () => {
    expect(appendSettings("SELECT 1;", { maxExecutionTime: 5 })).toBe(
      "SELECT 1 SETTINGS max_execution_time=5",
    )
  })

  it("ignores undefined / non-finite values", () => {
    expect(
      appendSettings("SELECT 1", {
        maxExecutionTime: undefined,
        maxMemoryUsage: NaN,
        maxThreads: 2,
      }),
    ).toBe("SELECT 1 SETTINGS max_threads=2")
  })
})

describe("resolveSettings", () => {
  it("returns undefined when no options", () => {
    expect(resolveSettings(undefined)).toBeUndefined()
    expect(resolveSettings({})).toBeUndefined()
  })

  it("returns profile defaults", () => {
    expect(resolveSettings({ profile: "discovery" })).toEqual(QueryProfile.discovery)
  })

  it("merges explicit settings on top of profile", () => {
    expect(
      resolveSettings({ profile: "discovery", settings: { maxExecutionTime: 99 } }),
    ).toEqual({ ...QueryProfile.discovery, maxExecutionTime: 99 })
  })

  it("unbounded profile yields no settings", () => {
    expect(resolveSettings({ profile: "unbounded" })).toEqual({})
  })

  it("explicit settings without profile pass through", () => {
    expect(resolveSettings({ settings: { maxThreads: 8 } })).toEqual({ maxThreads: 8 })
  })
})

describe("detectQuotaSetting", () => {
  it("matches max_execution_time errors", () => {
    expect(detectQuotaSetting("DB::Exception: Code: 159. TIMEOUT_EXCEEDED")).toBe(
      "max_execution_time",
    )
    expect(detectQuotaSetting("estimated query execution time exceeded")).toBe(
      "max_execution_time",
    )
    // Real Tinybird error format observed in production
    expect(
      detectQuotaSetting(
        "[Error] Timeout exceeded: elapsed 1.0009 seconds, maximum: 1 seconds.",
      ),
    ).toBe("max_execution_time")
  })

  it("matches max_memory_usage errors", () => {
    expect(detectQuotaSetting("Memory limit (for query) exceeded")).toBe("max_memory_usage")
    expect(detectQuotaSetting("MEMORY_LIMIT_EXCEEDED something")).toBe("max_memory_usage")
  })

  it("returns undefined on unrelated messages", () => {
    expect(detectQuotaSetting("Resource 'foo' not found")).toBeUndefined()
    expect(detectQuotaSetting(undefined)).toBeUndefined()
  })
})
