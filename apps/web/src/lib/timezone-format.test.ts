// @vitest-environment jsdom

import { describe, expect, it } from "vitest"
import {
  formatTimeInTimezone,
  formatTimestampInTimezone,
} from "./timezone-format"

describe("timezone-format", () => {
  it("treats Tinybird datetime strings without timezone as UTC", () => {
    const formatted = formatTimestampInTimezone("2026-02-27 12:54:36", {
      timeZone: "Europe/Berlin",
    })

    expect(formatted).toContain("01:54:36 PM")
  })

  it("normalizes Tinybird fractional seconds to milliseconds", () => {
    const formatted = formatTimestampInTimezone("2026-02-27 12:54:36.123456", {
      timeZone: "UTC",
      withMilliseconds: true,
    })

    expect(formatted).toContain("12:54:36")
    expect(formatted).toContain(".123")
  })

  it("formats the same instant differently in different timezones", () => {
    const input = "2024-01-01T12:00:00.000Z"

    const utc = formatTimestampInTimezone(input, { timeZone: "UTC" })
    const newYork = formatTimestampInTimezone(input, {
      timeZone: "America/New_York",
    })

    expect(utc).not.toBe(newYork)
    expect(utc).toContain("12:00:00")
    expect(newYork).toContain("07:00:00")
  })

  it("supports millisecond formatting", () => {
    const input = "2024-01-01T12:00:00.123Z"

    const formatted = formatTimestampInTimezone(input, {
      timeZone: "UTC",
      withMilliseconds: true,
    })

    expect(formatted).toContain("12:00:00")
    expect(formatted).toContain(".123")
  })

  it("supports timestamp with T separator but no timezone", () => {
    const formatted = formatTimestampInTimezone("2026-02-27T12:54:36", {
      timeZone: "Europe/Berlin",
    })

    expect(formatted).toContain("01:54:36 PM")
  })

  it("returns '-' for invalid values", () => {
    expect(
      formatTimestampInTimezone("not-a-date", { timeZone: "UTC" }),
    ).toBe("-")
    expect(formatTimeInTimezone("not-a-date", { timeZone: "UTC" })).toBe("-")
  })
})
