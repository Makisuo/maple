import { describe, expect, it } from "vitest"
import {
  deriveHostStatus,
  formatPercent,
  formatBytesPerSecond,
  formatLoad,
  severityLevel,
} from "./format"

describe("deriveHostStatus", () => {
  const now = new Date("2026-04-24T12:00:00Z").getTime()

  it("returns active for recent last-seen (under 60s)", () => {
    expect(deriveHostStatus("2026-04-24T11:59:45Z", now)).toBe("active")
  })

  it("returns idle when last-seen is past 2x scrape interval but under 10x", () => {
    expect(deriveHostStatus("2026-04-24T11:58:30Z", now)).toBe("idle")
  })

  it("returns down when last-seen is older than 10x scrape interval", () => {
    expect(deriveHostStatus("2026-04-24T11:55:00Z", now)).toBe("down")
  })

  it("returns down for a malformed ISO string", () => {
    expect(deriveHostStatus("not-a-date", now)).toBe("down")
  })
})

describe("formatPercent", () => {
  it("formats a small fraction as 0%", () => {
    expect(formatPercent(0.0004)).toBe("0%")
  })

  it("formats a mid-range fraction with one decimal", () => {
    expect(formatPercent(0.054)).toBe("5.4%")
  })

  it("drops decimals for values ≥10%", () => {
    expect(formatPercent(0.236)).toBe("24%")
  })

  it("returns em-dash for non-finite input", () => {
    expect(formatPercent(Number.NaN)).toBe("—")
  })
})

describe("formatBytesPerSecond", () => {
  it("returns 0 B/s for zero", () => {
    expect(formatBytesPerSecond(0)).toBe("0 B/s")
  })

  it("scales up to KB/s", () => {
    expect(formatBytesPerSecond(2048)).toBe("2.0 KB/s")
  })

  it("scales up to MB/s with integer rounding over 10", () => {
    expect(formatBytesPerSecond(50 * 1024 * 1024)).toBe("50 MB/s")
  })
})

describe("formatLoad", () => {
  it("formats with two decimals", () => {
    expect(formatLoad(1.3456)).toBe("1.35")
  })

  it("returns em-dash for NaN", () => {
    expect(formatLoad(Number.NaN)).toBe("—")
  })
})

describe("severityLevel", () => {
  it("returns ok below 60%", () => {
    expect(severityLevel(0)).toBe("ok")
    expect(severityLevel(0.59)).toBe("ok")
  })

  it("returns warn between 60% and 90%", () => {
    expect(severityLevel(0.6)).toBe("warn")
    expect(severityLevel(0.89)).toBe("warn")
  })

  it("returns crit at or above 90%", () => {
    expect(severityLevel(0.9)).toBe("crit")
    expect(severityLevel(1)).toBe("crit")
  })

  it("returns ok for non-finite input", () => {
    expect(severityLevel(Number.NaN)).toBe("ok")
  })
})
