import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import { vi } from "vitest"

const state: {
  connectCause: unknown
} = {
  connectCause: null
}

vi.mock("mysql2", () => ({
  createPool: () => ({
    query: (_sql: string, cb: (cause: unknown) => void) => cb(state.connectCause),
    end: (cb: () => void) => cb(),
    getConnection: (_cb: () => void) => undefined
  })
}))

const connectFailureReasonTag = (errno: number) =>
  Effect.gen(function*() {
    state.connectCause = { errno }
    const { MysqlClient } = yield* Effect.promise(() => import("@effect/sql-mysql2"))
    const error = yield* Effect.flip(MysqlClient.make({}))
    return error.reason._tag
  }).pipe(
    Effect.scoped,
    Effect.provide(Reactivity.layer)
  )

describe("MysqlClient SqlError classification", () => {
  it.effect("maps representative errno codes to reasons", () =>
    Effect.gen(function*() {
      const cases = [
        [1040, "ConnectionError"],
        [1045, "AuthenticationError"],
        [1142, "AuthorizationError"],
        [1064, "SqlSyntaxError"],
        [1062, "ConstraintError"],
        [1213, "DeadlockError"],
        [1205, "LockTimeoutError"],
        [3024, "StatementTimeoutError"]
      ] as const

      for (const [errno, expectedTag] of cases) {
        const tag = yield* connectFailureReasonTag(errno)
        assert.strictEqual(tag, expectedTag)
      }
    }))

  it.effect("falls back to UnknownError for unmapped errno", () =>
    Effect.gen(function*() {
      const tag = yield* connectFailureReasonTag(9999)
      assert.strictEqual(tag, "UnknownError")
    }))
})
