/**
 * @since 4.0.0
 */
import * as Predicate from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"

const TypeId = "~effect/sql/SqlError" as const
const ReasonTypeId = "~effect/sql/SqlError/Reason" as const

const ReasonFields = {
  cause: Schema.Defect,
  message: Schema.optional(Schema.String),
  operation: Schema.optional(Schema.String)
}

/**
 * @since 4.0.0
 */
export class ConnectionError extends Schema.TaggedErrorClass<ConnectionError>("effect/sql/SqlError/ConnectionError")(
  "ConnectionError",
  ReasonFields
) {
  /**
   * @since 4.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * @since 4.0.0
   */
  get isRetryable(): boolean {
    return true
  }
}

/**
 * @since 4.0.0
 */
export class AuthenticationError extends Schema.TaggedErrorClass<AuthenticationError>(
  "effect/sql/SqlError/AuthenticationError"
)("AuthenticationError", ReasonFields) {
  /**
   * @since 4.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * @since 4.0.0
   */
  get isRetryable(): boolean {
    return false
  }
}

/**
 * @since 4.0.0
 */
export class AuthorizationError extends Schema.TaggedErrorClass<AuthorizationError>(
  "effect/sql/SqlError/AuthorizationError"
)("AuthorizationError", ReasonFields) {
  /**
   * @since 4.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * @since 4.0.0
   */
  get isRetryable(): boolean {
    return false
  }
}

/**
 * @since 4.0.0
 */
export class SqlSyntaxError extends Schema.TaggedErrorClass<SqlSyntaxError>("effect/sql/SqlError/SqlSyntaxError")(
  "SqlSyntaxError",
  ReasonFields
) {
  /**
   * @since 4.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * @since 4.0.0
   */
  get isRetryable(): boolean {
    return false
  }
}

/**
 * @since 4.0.0
 */
export class ConstraintError extends Schema.TaggedErrorClass<ConstraintError>("effect/sql/SqlError/ConstraintError")(
  "ConstraintError",
  ReasonFields
) {
  /**
   * @since 4.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * @since 4.0.0
   */
  get isRetryable(): boolean {
    return false
  }
}

/**
 * @since 4.0.0
 */
export class DeadlockError extends Schema.TaggedErrorClass<DeadlockError>("effect/sql/SqlError/DeadlockError")(
  "DeadlockError",
  ReasonFields
) {
  /**
   * @since 4.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * @since 4.0.0
   */
  get isRetryable(): boolean {
    return true
  }
}

/**
 * @since 4.0.0
 */
export class SerializationError extends Schema.TaggedErrorClass<SerializationError>(
  "effect/sql/SqlError/SerializationError"
)("SerializationError", ReasonFields) {
  /**
   * @since 4.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * @since 4.0.0
   */
  get isRetryable(): boolean {
    return true
  }
}

/**
 * @since 4.0.0
 */
export class LockTimeoutError extends Schema.TaggedErrorClass<LockTimeoutError>("effect/sql/SqlError/LockTimeoutError")(
  "LockTimeoutError",
  ReasonFields
) {
  /**
   * @since 4.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * @since 4.0.0
   */
  get isRetryable(): boolean {
    return true
  }
}

/**
 * @since 4.0.0
 */
export class StatementTimeoutError extends Schema.TaggedErrorClass<StatementTimeoutError>(
  "effect/sql/SqlError/StatementTimeoutError"
)("StatementTimeoutError", ReasonFields) {
  /**
   * @since 4.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * @since 4.0.0
   */
  get isRetryable(): boolean {
    return true
  }
}

/**
 * @since 4.0.0
 */
export class UnknownError extends Schema.TaggedErrorClass<UnknownError>("effect/sql/SqlError/UnknownError")(
  "UnknownError",
  ReasonFields
) {
  /**
   * @since 4.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * @since 4.0.0
   */
  get isRetryable(): boolean {
    return false
  }
}

/**
 * @since 4.0.0
 */
export type SqlErrorReason =
  | ConnectionError
  | AuthenticationError
  | AuthorizationError
  | SqlSyntaxError
  | ConstraintError
  | DeadlockError
  | SerializationError
  | LockTimeoutError
  | StatementTimeoutError
  | UnknownError

/**
 * @since 4.0.0
 */
export const SqlErrorReason: Schema.Union<[
  typeof ConnectionError,
  typeof AuthenticationError,
  typeof AuthorizationError,
  typeof SqlSyntaxError,
  typeof ConstraintError,
  typeof DeadlockError,
  typeof SerializationError,
  typeof LockTimeoutError,
  typeof StatementTimeoutError,
  typeof UnknownError
]> = Schema.Union([
  ConnectionError,
  AuthenticationError,
  AuthorizationError,
  SqlSyntaxError,
  ConstraintError,
  DeadlockError,
  SerializationError,
  LockTimeoutError,
  StatementTimeoutError,
  UnknownError
])

/**
 * @since 4.0.0
 */
export class SqlError extends Schema.TaggedErrorClass<SqlError>("effect/sql/SqlError")("SqlError", {
  reason: SqlErrorReason
}) {
  /**
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId

  /**
   * @since 4.0.0
   */
  override readonly cause = this.reason

  /**
   * @since 4.0.0
   */
  override get message(): string {
    return this.reason.message || this.reason._tag
  }

  /**
   * @since 4.0.0
   */
  get isRetryable(): boolean {
    return this.reason.isRetryable
  }
}

/**
 * @since 4.0.0
 */
export const isSqlError = (u: unknown): u is SqlError => Predicate.hasProperty(u, TypeId)

/**
 * @since 4.0.0
 */
export const isSqlErrorReason = (u: unknown): u is SqlErrorReason => Predicate.hasProperty(u, ReasonTypeId)

type SqliteClassifyOptions = {
  readonly message?: string | undefined
  readonly operation?: string | undefined
}

const sqliteCodeFromCause = (cause: unknown): string | number | undefined => {
  if (!Predicate.hasProperty(cause, "code")) {
    return undefined
  }
  const code = cause.code
  return typeof code === "string" || typeof code === "number" ? code : undefined
}

const sqliteNumericCodeFromCause = (cause: unknown): number | undefined => {
  const code = sqliteCodeFromCause(cause)
  if (typeof code === "number") {
    return code
  }
  if (!Predicate.hasProperty(cause, "errno")) {
    return undefined
  }
  const errno = cause.errno
  return typeof errno === "number" ? errno : undefined
}

const matchesSqliteCode = (code: string, expected: string): boolean =>
  code === expected || code.startsWith(expected + "_")

/**
 * @since 4.0.0
 */
export const classifySqliteError = (
  cause: unknown,
  { message, operation }: SqliteClassifyOptions = {}
): SqlErrorReason => {
  const props = {
    cause,
    message,
    operation
  }
  const code = sqliteCodeFromCause(cause)

  if (typeof code === "string") {
    if (matchesSqliteCode(code, "SQLITE_AUTH")) {
      return new AuthenticationError(props)
    }
    if (matchesSqliteCode(code, "SQLITE_PERM")) {
      return new AuthorizationError(props)
    }
    if (matchesSqliteCode(code, "SQLITE_CONSTRAINT")) {
      return new ConstraintError(props)
    }
    if (matchesSqliteCode(code, "SQLITE_BUSY") || matchesSqliteCode(code, "SQLITE_LOCKED")) {
      return new LockTimeoutError(props)
    }
    if (matchesSqliteCode(code, "SQLITE_CANTOPEN")) {
      return new ConnectionError(props)
    }
  }

  const numericCode = sqliteNumericCodeFromCause(cause)
  if (typeof numericCode === "number") {
    const code = numericCode & 0xff
    switch (code) {
      case 23:
        return new AuthenticationError(props)
      case 3:
        return new AuthorizationError(props)
      case 19:
        return new ConstraintError(props)
      case 5:
      case 6:
        return new LockTimeoutError(props)
      case 14:
        return new ConnectionError(props)
      default:
        return new UnknownError(props)
    }
  }

  return new UnknownError(props)
}

/**
 * @since 4.0.0
 */
export class ResultLengthMismatch
  extends Schema.TaggedErrorClass<ResultLengthMismatch>("effect/sql/ResultLengthMismatch")("ResultLengthMismatch", {
    expected: Schema.Number,
    actual: Schema.Number
  })
{
  /**
   * @since 4.0.0
   */
  override get message() {
    return `Expected ${this.expected} results but got ${this.actual}`
  }
}
