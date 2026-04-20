import { PgClient } from "@effect/sql-pg"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"

const queryFailureReasonTag = (cause: unknown) =>
  Effect.gen(function*() {
    const client = yield* PgClient.fromPool({
      acquire: Effect.succeed(makeFailingPool(cause) as any)
    })
    const error = yield* Effect.flip(client`SELECT 1`)
    return error.reason._tag
  }).pipe(
    Effect.scoped,
    Effect.provide(Reactivity.layer)
  )

const makeFailingPool = (cause: unknown) => ({
  options: {},
  ending: false,
  connect: (cb: (cause: unknown, client: any) => void) => cb(null, makeFailingClient(cause)),
  query: () => undefined
})

const makeFailingClient = (cause: unknown) => ({
  once: () => undefined,
  off: () => undefined,
  release: () => undefined,
  query: (_sql: string, _params: ReadonlyArray<unknown>, cb: (cause: unknown) => void) => cb(cause)
})

describe("PgClient SqlError classification", () => {
  it.effect("checks 42501 before generic 42*", () =>
    Effect.gen(function*() {
      const authorizationTag = yield* queryFailureReasonTag({ code: "42501" })
      assert.strictEqual(authorizationTag, "AuthorizationError")

      const syntaxTag = yield* queryFailureReasonTag({ code: "42P01" })
      assert.strictEqual(syntaxTag, "SqlSyntaxError")
    }))

  it.effect("falls back to UnknownError for unmapped SQLSTATE", () =>
    Effect.gen(function*() {
      const tag = yield* queryFailureReasonTag({ code: "ZZZZZ" })
      assert.strictEqual(tag, "UnknownError")
    }))
})
