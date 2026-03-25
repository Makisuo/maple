import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import * as SqlError from "effect/unstable/sql/SqlError"

type ReasonCase = {
  readonly tag: SqlError.SqlErrorReason["_tag"]
  readonly isRetryable: boolean
  readonly ctor: new(args: {
    readonly cause: unknown
    readonly message?: string | undefined
    readonly operation?: string | undefined
  }) => SqlError.SqlErrorReason
}

const reasonCases = [
  { tag: "ConnectionError", isRetryable: true, ctor: SqlError.ConnectionError },
  { tag: "AuthenticationError", isRetryable: false, ctor: SqlError.AuthenticationError },
  { tag: "AuthorizationError", isRetryable: false, ctor: SqlError.AuthorizationError },
  { tag: "SqlSyntaxError", isRetryable: false, ctor: SqlError.SqlSyntaxError },
  { tag: "ConstraintError", isRetryable: false, ctor: SqlError.ConstraintError },
  { tag: "DeadlockError", isRetryable: true, ctor: SqlError.DeadlockError },
  { tag: "SerializationError", isRetryable: true, ctor: SqlError.SerializationError },
  { tag: "LockTimeoutError", isRetryable: true, ctor: SqlError.LockTimeoutError },
  { tag: "StatementTimeoutError", isRetryable: true, ctor: SqlError.StatementTimeoutError },
  { tag: "UnknownError", isRetryable: false, ctor: SqlError.UnknownError }
] as const satisfies ReadonlyArray<ReasonCase>

describe("SqlError", () => {
  it("reason classes expose expected tags and retryability", () => {
    for (const reasonCase of reasonCases) {
      const reason = new reasonCase.ctor({
        cause: { tag: reasonCase.tag },
        message: `${reasonCase.tag} message`,
        operation: "execute"
      })

      assert.strictEqual(reason._tag, reasonCase.tag)
      assert.strictEqual(reason.isRetryable, reasonCase.isRetryable)
      assert.strictEqual(reason.message, `${reasonCase.tag} message`)
      assert.strictEqual(reason.operation, "execute")
      assert.deepStrictEqual(reason.cause, { tag: reasonCase.tag })
    }
  })

  it("delegates message, cause and retryability for every reason type", () => {
    for (const reasonCase of reasonCases) {
      const withoutMessage = new reasonCase.ctor({
        cause: { tag: `${reasonCase.tag}-fallback` }
      })
      const withMessage = new reasonCase.ctor({
        cause: { tag: `${reasonCase.tag}-custom` },
        message: `${reasonCase.tag} custom`,
        operation: "execute"
      })
      const withEmptyMessage = new reasonCase.ctor({
        cause: { tag: `${reasonCase.tag}-empty` },
        message: ""
      })
      const fallbackError = new SqlError.SqlError({ reason: withoutMessage })
      const explicitMessageError = new SqlError.SqlError({ reason: withMessage })
      const emptyMessageError = new SqlError.SqlError({ reason: withEmptyMessage })

      assert.strictEqual(fallbackError.message, reasonCase.tag)
      assert.strictEqual(fallbackError.cause, withoutMessage)
      assert.strictEqual(fallbackError.isRetryable, reasonCase.isRetryable)

      assert.strictEqual(explicitMessageError.message, `${reasonCase.tag} custom`)
      assert.strictEqual(explicitMessageError.cause, withMessage)
      assert.strictEqual(explicitMessageError.isRetryable, reasonCase.isRetryable)

      assert.strictEqual(emptyMessageError.message, reasonCase.tag)
      assert.strictEqual(emptyMessageError.cause, withEmptyMessage)
      assert.strictEqual(emptyMessageError.isRetryable, reasonCase.isRetryable)
    }
  })

  it("isSqlError only matches the SqlError wrapper", () => {
    const reason = new SqlError.UnknownError({
      cause: new Error("boom")
    })
    const error = new SqlError.SqlError({ reason })
    const mismatch = new SqlError.ResultLengthMismatch({ expected: 1, actual: 0 })

    assert.strictEqual(SqlError.isSqlError(error), true)
    assert.strictEqual(SqlError.isSqlError(reason), false)
    assert.strictEqual(SqlError.isSqlError(mismatch), false)
  })

  it("isSqlErrorReason only matches reason values", () => {
    const reason = new SqlError.UnknownError({
      cause: new Error("boom")
    })
    const error = new SqlError.SqlError({ reason })

    assert.strictEqual(SqlError.isSqlErrorReason(reason), true)
    assert.strictEqual(SqlError.isSqlErrorReason(error), false)
  })

  it("classifySqliteError maps sqlite code strings and numeric codes", () => {
    const byString = SqlError.classifySqliteError({ code: "SQLITE_CONSTRAINT_UNIQUE" })
    const byNumber = SqlError.classifySqliteError({ errno: 2067 })
    const unknown = SqlError.classifySqliteError({ code: "NOT_SQLITE" })

    assert.strictEqual(byString._tag, "ConstraintError")
    assert.strictEqual(byNumber._tag, "ConstraintError")
    assert.strictEqual(unknown._tag, "UnknownError")
  })

  for (const reasonCase of reasonCases) {
    it.effect(`schema roundtrip for SqlError wrapping ${reasonCase.tag}`, () =>
      Effect.gen(function*() {
        const cause = { tag: reasonCase.tag }
        const error = new SqlError.SqlError({
          reason: new reasonCase.ctor({
            cause,
            message: `${reasonCase.tag} message`,
            operation: "execute"
          })
        })

        const encoded = yield* Schema.encodeEffect(SqlError.SqlError)(error)
        const decoded = yield* Schema.decodeEffect(SqlError.SqlError)(encoded)

        assert.strictEqual(decoded._tag, "SqlError")
        assert.strictEqual(decoded.reason._tag, reasonCase.tag)
        assert.strictEqual(decoded.reason.message, `${reasonCase.tag} message`)
        assert.strictEqual(decoded.reason.operation, "execute")
        assert.deepStrictEqual(decoded.reason.cause, cause)
        assert.strictEqual(decoded.message, `${reasonCase.tag} message`)
        assert.strictEqual(decoded.isRetryable, reasonCase.isRetryable)
        assert.strictEqual(decoded.cause, decoded.reason)
      }))
  }
})
