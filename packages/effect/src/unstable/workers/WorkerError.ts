/**
 * @since 4.0.0
 */
import { hasProperty } from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"

const TypeId = "~effect/workers/WorkerError" as const

/**
 * @since 4.0.0
 * @category Symbols
 */
export type TypeId = typeof TypeId

/**
 * @since 4.0.0
 * @category Guards
 */
export const isWorkerError = (u: unknown): u is WorkerError => hasProperty(u, TypeId)

/**
 * @since 4.0.0
 * @category Models
 */
export class WorkerSpawnError extends Schema.ErrorClass<WorkerSpawnError>(
  "effect/workers/WorkerError/WorkerSpawnError"
)({
  _tag: Schema.tag("WorkerSpawnError"),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect)
}) {}

/**
 * @since 4.0.0
 * @category Models
 */
export class WorkerSendError extends Schema.ErrorClass<WorkerSendError>(
  "effect/workers/WorkerError/WorkerSendError"
)({
  _tag: Schema.tag("WorkerSendError"),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect)
}) {}

/**
 * @since 4.0.0
 * @category Models
 */
export class WorkerReceiveError extends Schema.ErrorClass<WorkerReceiveError>(
  "effect/workers/WorkerError/WorkerReceiveError"
)({
  _tag: Schema.tag("WorkerReceiveError"),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect)
}) {}

/**
 * @since 4.0.0
 * @category Models
 */
export class WorkerUnknownError extends Schema.ErrorClass<WorkerUnknownError>(
  "effect/workers/WorkerError/WorkerUnknownError"
)({
  _tag: Schema.tag("WorkerUnknownError"),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect)
}) {}

/**
 * @since 4.0.0
 * @category Models
 */
export type WorkerErrorReason =
  | WorkerSpawnError
  | WorkerSendError
  | WorkerReceiveError
  | WorkerUnknownError

/**
 * @since 4.0.0
 * @category Models
 */
export const WorkerErrorReason: Schema.Union<[
  typeof WorkerSpawnError,
  typeof WorkerSendError,
  typeof WorkerReceiveError,
  typeof WorkerUnknownError
]> = Schema.Union([
  WorkerSpawnError,
  WorkerSendError,
  WorkerReceiveError,
  WorkerUnknownError
])

/**
 * @since 4.0.0
 * @category Models
 */
export class WorkerError extends Schema.ErrorClass<WorkerError>(TypeId)({
  _tag: Schema.tag("WorkerError"),
  reason: WorkerErrorReason
}) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: {
    readonly reason: WorkerErrorReason
  }) {
    super({
      ...props,
      cause: props.reason.cause
    } as any)
  }
  /**
   * @since 4.0.0
   */
  readonly [TypeId]: TypeId = TypeId

  override get message(): string {
    return this.reason.message
  }
}
