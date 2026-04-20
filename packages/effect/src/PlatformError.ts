/**
 * @since 4.0.0
 */
import * as Data from "./Data.ts"

const TypeId = "~effect/platform/PlatformError"

/**
 * @since 4.0.0
 * @category Models
 */
export class BadArgument extends Data.TaggedError("BadArgument")<{
  module: string
  method: string
  description?: string | undefined
  cause?: unknown
}> {
  /**
   * @since 4.0.0
   */
  override get message(): string {
    return `${this.module}.${this.method}${this.description ? `: ${this.description}` : ""}`
  }
}

/**
 * @since 4.0.0
 * @category Model
 */
export type SystemErrorTag =
  | "AlreadyExists"
  | "BadResource"
  | "Busy"
  | "InvalidData"
  | "NotFound"
  | "PermissionDenied"
  | "TimedOut"
  | "UnexpectedEof"
  | "Unknown"
  | "WouldBlock"
  | "WriteZero"

/**
 * @since 4.0.0
 * @category models
 */
export class SystemError extends Data.Error<{
  _tag: SystemErrorTag
  module: string
  method: string
  description?: string | undefined
  syscall?: string | undefined
  pathOrDescriptor?: string | number | undefined
  cause?: unknown
}> {
  /**
   * @since 4.0.0
   */
  override get message(): string {
    return `${this._tag}: ${this.module}.${this.method}${
      this.pathOrDescriptor !== undefined ? ` (${this.pathOrDescriptor})` : ""
    }${this.description ? `: ${this.description}` : ""}`
  }
}

/**
 * @since 4.0.0
 * @category Models
 */
export class PlatformError extends Data.TaggedError("PlatformError")<{
  reason: BadArgument | SystemError
}> {
  constructor(reason: BadArgument | SystemError) {
    if ("cause" in reason) {
      super({ reason, cause: reason.cause } as any)
    } else {
      super({ reason })
    }
  }

  /**
   * @since 4.0.0
   */
  readonly [TypeId]: typeof TypeId = TypeId

  override get message(): string {
    return this.reason.message
  }
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const systemError = (options: {
  readonly _tag: SystemErrorTag
  readonly module: string
  readonly method: string
  readonly description?: string | undefined
  readonly syscall?: string | undefined
  readonly pathOrDescriptor?: string | number | undefined
  readonly cause?: unknown
}): PlatformError => new PlatformError(new SystemError(options))

/**
 * @since 4.0.0
 * @category constructors
 */
export const badArgument = (options: {
  readonly module: string
  readonly method: string
  readonly description?: string | undefined
  readonly cause?: unknown
}): PlatformError => new PlatformError(new BadArgument(options))
