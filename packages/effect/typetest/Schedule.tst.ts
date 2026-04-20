import { hole } from "effect"
import * as Schedule from "effect/Schedule"
import { describe, expect, it } from "tstyche"

describe("Schedule", () => {
  it("isSchedule", () => {
    const input = hole<{ a: number } | Schedule.Schedule<string, number, never, never>>()
    if (Schedule.isSchedule(input)) {
      expect(input).type.toBe<Schedule.Schedule<string, number, never, never>>()
    }
  })
})
