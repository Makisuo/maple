/**
 * Context-aware redaction for sensitive values.
 *
 * The `Redactable` module provides a protocol for objects that need to present
 * alternative representations of themselves depending on the runtime context.
 * Typical use cases include masking secrets, tokens, or personal data in logs, traces,
 * and serialized output.
 *
 * ## Mental model
 *
 * - **Redactable** - an object that implements `[symbolRedactable]`, a method
 *   that receives the current `Context` and returns a replacement value.
 * - **symbolRedactable** - the well-known `Symbol` key that marks an object as
 *   redactable.
 * - **redact** - the primary entry point: pass any value and get back either its
 *   redacted form (if it is `Redactable`) or the original value unchanged.
 * - **getRedacted** - lower-level helper that calls `[symbolRedactable]` directly
 *   on a value already known to be `Redactable`.
 * - The `Context` passed to `[symbolRedactable]` comes from the current fiber.
 *   If no fiber is active, an empty `Context` is used.
 *
 * ## Common tasks
 *
 * - **Make a value redactable**: implement the {@link Redactable} interface by
 *   adding a `[symbolRedactable]` method.
 * - **Redact an unknown value**: call {@link redact} - it returns the original
 *   value when it is not redactable.
 * - **Check if a value is redactable**: use {@link isRedactable}.
 * - **Get the redacted form of a known `Redactable`**: use {@link getRedacted}.
 *
 * ## Gotchas
 *
 * - `[symbolRedactable]` receives the fiber's `Context` as its argument.
 * - Outside of an Effect runtime (no current fiber), `getRedacted` still works
 *   but passes an empty `Context`, so service lookups will not find anything.
 * - `redact` is not recursive: if a redactable object contains nested
 *   redactable values, only the outermost redaction is applied.
 *
 * ## Quickstart
 *
 * **Example** (Masking an API key)
 *
 * ```ts
 * import { Context, Redactable } from "effect"
 *
 * class ApiKey {
 *   constructor(readonly raw: string) {}
 *
 *   [Redactable.symbolRedactable](_ctx: Context.Context<never>) {
 *     return this.raw.slice(0, 4) + "..."
 *   }
 * }
 *
 * const key = new ApiKey("sk-1234567890abcdef")
 *
 * console.log(Redactable.isRedactable(key))  // true
 * console.log(Redactable.redact(key))         // "sk-1..."
 * console.log(Redactable.redact("plain"))     // "plain"
 * ```
 *
 * ## See also
 *
 * - {@link Redactable} - the interface to implement
 * - {@link symbolRedactable} - the symbol key
 * - {@link redact} - the main redaction entry point
 *
 * @since 4.0.0
 */
import type * as Context from "./Context.ts"
import { pipeArguments } from "./Pipeable.ts"
import { hasProperty } from "./Predicate.ts"

/**
 * Symbol used to identify objects that implement the {@link Redactable}
 * protocol.
 *
 * Add a method under this key to make an object redactable. The method
 * receives the current `Context` and must return the replacement value.
 *
 * - Use this symbol as the property key when implementing {@link Redactable}.
 * - Registered globally via `Symbol.for("~effect/Redactable")`,
 *   so it is identical across multiple copies of the library at runtime.
 *
 * **Example** (Masking an API key)
 *
 * ```ts
 * import { Context, Redactable } from "effect"
 *
 * class ApiKey {
 *   constructor(readonly raw: string) {}
 *
 *   [Redactable.symbolRedactable](_ctx: Context.Context<never>) {
 *     return this.raw.slice(0, 4) + "..."
 *   }
 * }
 * ```
 *
 * See also:
 * - {@link Redactable} - the interface this symbol belongs to
 * - {@link isRedactable} - check whether a value has this symbol
 *
 * @since 4.0.0
 * @category symbol
 */
export const symbolRedactable: unique symbol = Symbol.for("~effect/Redactable")

/**
 * Interface for objects that provide context-aware redacted representations.
 *
 * - Implement this interface on any class or object that holds sensitive data
 *   and should present a sanitized form when inspected or logged.
 * - The `[symbolRedactable]` method receives the current fiber's `Context`.
 * - If no fiber is active, an empty `Context` is provided.
 *
 * **Example** (Masking an API key)
 *
 * ```ts
 * import { Context, Redactable } from "effect"
 *
 * class ApiKey {
 *   constructor(readonly raw: string) {}
 *
 *   [Redactable.symbolRedactable](_ctx: Context.Context<never>) {
 *     return this.raw.slice(0, 4) + "..."
 *   }
 * }
 * ```
 *
 * See also:
 * - {@link symbolRedactable} - the symbol key to implement
 * - {@link redact} - apply redaction to any value
 * - {@link isRedactable} - type guard for this interface
 *
 * @since 4.0.0
 * @category Model
 */
export interface Redactable {
  readonly [symbolRedactable]: (context: Context.Context<never>) => unknown
}

/**
 * Type guard that checks whether a value implements the {@link Redactable}
 * interface.
 *
 * See also:
 * - {@link Redactable} - the interface being checked
 * - {@link redact} - applies redaction if the value is redactable
 *
 * @since 4.0.0
 * @category guards
 */
export const isRedactable = (u: unknown): u is Redactable => hasProperty(u, symbolRedactable)

/**
 * Redacts a value if it implements {@link Redactable}, otherwise returns it
 * unchanged.
 *
 * - Use this as the general-purpose entry point for redaction: it is safe to
 *   call on any value.
 * - Internally calls {@link isRedactable} and, if `true`, delegates to
 *   {@link getRedacted}.
 * - Not recursive: nested redactable values inside the returned object are not
 *   automatically redacted.
 * - Pure with respect to its argument (does not mutate the input).
 *
 * See also:
 * - {@link isRedactable} - check before redacting
 * - {@link getRedacted} - lower-level variant for known redactables
 *
 * @since 4.0.0
 */
export function redact(u: unknown): unknown {
  if (isRedactable(u)) return getRedacted(u)
  return u
}

/**
 * Calls `[symbolRedactable]` on a value that is already known to be
 * {@link Redactable} and returns the result.
 *
 * - Use this when you have already verified the value is `Redactable` (e.g.,
 *   via {@link isRedactable}) and want to avoid a second check.
 * - Reads the current fiber's `Context` from the global fiber reference. If
 *   no fiber is active, an empty `Context` is passed to the redaction
 *   method.
 * - Does not mutate the input.
 *
 * See also:
 * - {@link redact} - higher-level variant that handles non-redactable values
 * - {@link isRedactable} - type guard to verify before calling this
 *
 * @since 4.0.0
 */
export function getRedacted(redactable: Redactable): unknown {
  return redactable[symbolRedactable]((globalThis as any)[currentFiberTypeId]?.context ?? emptyContext)
}

/** @internal */
export const currentFiberTypeId = "~effect/Fiber/currentFiber"

const emptyContext: Context.Context<never> = {
  "~effect/Context": {} as any,
  mapUnsafe: new Map(),
  pipe() {
    return pipeArguments(this, arguments)
  }
} as any
