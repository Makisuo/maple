import { describe, expect, it } from "@effect/vitest"
import { Cause } from "effect"
import { AsyncResult } from "effect/unstable/reactivity"

describe("AsyncResult", () => {
  describe("builder", () => {
    it("onDefect handles defects", () => {
      const defect = new Error("boom")
      const result = AsyncResult.failure<number, string>(Cause.die(defect))

      const handled = AsyncResult.builder(result)
        .onDefect((received) => received)
        .orElse(() => null)

      expect(handled).toBe(defect)
    })

    it("onDefect does not handle typed errors", () => {
      const handled = AsyncResult.builder(AsyncResult.fail("error"))
        .onDefect(() => "defect")
        .orElse(() => "fallback")

      expect(handled).toEqual("fallback")
    })
  })
})
