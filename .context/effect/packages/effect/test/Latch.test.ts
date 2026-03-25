import { assert, describe, it } from "@effect/vitest"
import { Effect, Latch } from "effect"

describe("Latch", () => {
  it.effect("module-level combinators delegate to the instance api", () =>
    Effect.gen(function*() {
      const latch = yield* Latch.make(false)

      const opened = yield* Latch.open(latch)
      assert.isTrue(opened)

      const value = yield* Latch.whenOpen(latch, Effect.succeed("ok"))
      assert.strictEqual(value, "ok")

      const piped = yield* Effect.succeed("pipe").pipe(Latch.whenOpen(latch))
      assert.strictEqual(piped, "pipe")

      const closed = yield* Latch.close(latch)
      assert.isTrue(closed)

      const released = yield* Latch.release(latch)
      assert.isFalse(released)
    }))

  it.effect("module-level await waits for open", () =>
    Effect.gen(function*() {
      const latch = yield* Latch.make(false)
      let done = false

      yield* Effect.forkChild(
        Effect.andThen(
          Latch.await(latch),
          Effect.sync(() => {
            done = true
          })
        )
      )

      yield* Effect.yieldNow
      assert.isFalse(done)

      yield* Latch.open(latch)
      yield* Effect.yieldNow

      assert.isTrue(done)
    }))
})
