import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import { vi } from "vitest"

const state: {
  connectCause: unknown
  requestCauses: Array<unknown>
} = {
  connectCause: null,
  requestCauses: []
}

class MockRequest {
  callback: (cause: unknown, rowCount: number, rows: ReadonlyArray<any>) => void

  constructor(
    _sql: string,
    callback: (cause: unknown, rowCount: number, rows: ReadonlyArray<any>) => void
  ) {
    this.callback = callback
  }

  addParameter() {
    return
  }

  addOutputParameter() {
    return
  }

  on() {
    return
  }
}

class MockConnection {
  connect(callback: (cause: unknown) => void) {
    callback(state.connectCause)
  }

  close() {
    return
  }

  on() {
    return
  }

  beginTransaction(callback: (cause: unknown) => void) {
    callback(null)
  }

  commitTransaction(callback: (cause: unknown) => void) {
    callback(null)
  }

  saveTransaction(callback: (cause: unknown) => void) {
    callback(null)
  }

  rollbackTransaction(callback: (cause: unknown) => void) {
    callback(null)
  }

  cancel() {
    return
  }

  execSql(request: MockRequest) {
    const cause = state.requestCauses.length > 0 ? state.requestCauses.shift() : null
    request.callback(cause, 0, [])
  }

  callProcedure(request: MockRequest) {
    this.execSql(request)
  }
}

vi.mock("tedious", () => ({
  Connection: MockConnection,
  Request: MockRequest,
  TYPES: {
    VarChar: {},
    Int: {},
    BigInt: {},
    Bit: {},
    DateTime: {},
    VarBinary: {}
  }
}))

const queryFailureReasonTag = (number: number) =>
  Effect.gen(function*() {
    state.connectCause = null
    state.requestCauses = [null, { number }]
    const { MssqlClient } = yield* Effect.promise(() => import("@effect/sql-mssql"))
    const client = yield* MssqlClient.make({ server: "localhost" })
    const error = yield* Effect.flip(client`SELECT 1`)
    return error.reason._tag
  }).pipe(
    Effect.scoped,
    Effect.provide(Reactivity.layer)
  )

describe("MssqlClient SqlError classification", () => {
  it.effect("maps representative error numbers to reasons", () =>
    Effect.gen(function*() {
      const cases = [
        [233, "ConnectionError"],
        [18456, "AuthenticationError"],
        [229, "AuthorizationError"],
        [102, "SqlSyntaxError"],
        [547, "ConstraintError"],
        [1205, "DeadlockError"],
        [3960, "SerializationError"],
        [1222, "LockTimeoutError"]
      ] as const

      for (const [number, expectedTag] of cases) {
        const tag = yield* queryFailureReasonTag(number)
        assert.strictEqual(tag, expectedTag)
      }
    }))

  it.effect("falls back to UnknownError for unmapped error numbers", () =>
    Effect.gen(function*() {
      const tag = yield* queryFailureReasonTag(99999)
      assert.strictEqual(tag, "UnknownError")
    }))
})
