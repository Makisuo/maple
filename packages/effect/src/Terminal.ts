/**
 * @since 4.0.0
 */
import type * as Cause from "./Cause.ts"
import type * as Effect from "./Effect.ts"
import type * as Option from "./Option.ts"
import type { PlatformError } from "./PlatformError.ts"
import * as Predicate from "./Predicate.ts"
import type * as Queue from "./Queue.ts"
import * as Schema from "./Schema.ts"
import type * as Scope from "./Scope.ts"
import * as ServiceMap from "./ServiceMap.ts"

const TypeId = "~effect/platform/Terminal"

/**
 * A `Terminal` represents a command-line interface which can read input from a
 * user and display messages to a user.
 *
 * @since 4.0.0
 * @category Models
 */
export interface Terminal {
  readonly [TypeId]: typeof TypeId

  /**
   * The number of columns available on the platform's terminal interface.
   */
  readonly columns: Effect.Effect<number>
  /**
   * Reads input events from the default standard input.
   */
  readonly readInput: Effect.Effect<Queue.Dequeue<UserInput, Cause.Done>, never, Scope.Scope>
  /**
   * Reads a single line from the default standard input.
   */
  readonly readLine: Effect.Effect<string, QuitError>
  /**
   * Displays text to the default standard output.
   */
  readonly display: (text: string) => Effect.Effect<void, PlatformError>
}

/**
 * @since 4.0.0
 * @category Models
 */
export interface Key {
  /**
   * The name of the key being pressed.
   */
  readonly name: string
  /**
   * If set to `true`, then the user is also holding down the `Ctrl` key.
   */
  readonly ctrl: boolean
  /**
   * If set to `true`, then the user is also holding down the `Meta` key.
   */
  readonly meta: boolean
  /**
   * If set to `true`, then the user is also holding down the `Shift` key.
   */
  readonly shift: boolean
}

/**
 * @since 4.0.0
 * @category Models
 */
export interface UserInput {
  /**
   * The character read from the user (if any).
   */
  readonly input: Option.Option<string>
  /**
   * The key that the user pressed.
   */
  readonly key: Key
}

const QuitErrorTypeId = "effect/platform/Terminal/QuitError"

/**
 * A `QuitError` represents an error that occurs when a user attempts to
 * quit out of a `Terminal` prompt for input (usually by entering `ctrl`+`c`).
 *
 * @since 4.0.0
 * @category QuitError
 */
export class QuitError extends Schema.ErrorClass("QuitError")({
  _tag: Schema.tag("QuitError")
}) {
  /**
   * @since 4.0.0
   */
  readonly [QuitErrorTypeId] = QuitErrorTypeId
}

/**
 * @since 4.0.0
 * @category QuitError
 */
export const isQuitError = (u: unknown): u is QuitError => Predicate.hasProperty(u, QuitErrorTypeId)

/**
 * @since 4.0.0
 * @category Services
 */
export const Terminal: ServiceMap.Service<Terminal, Terminal> = ServiceMap.Service("effect/platform/Terminal")

/**
 * Creates a Terminal implementation
 *
 * @since 4.0.0
 * @category Constructors
 */
export const make = (
  impl: Omit<Terminal, typeof TypeId>
): Terminal => Terminal.of({ ...impl, [TypeId]: TypeId })
