/**
 * @since 4.0.0
 */
import { pipeArguments } from "./Pipeable.ts"
import { hasProperty } from "./Predicate.ts"
import type * as ServiceMap from "./ServiceMap.ts"

/**
 * Symbol used to identify objects that implement redaction capabilities.
 *
 * @since 4.0.0
 * @category symbol
 */
export const symbolRedactable: unique symbol = Symbol.for("~effect/Inspectable/redactable")

/**
 * Interface for objects that can provide redacted representations.
 *
 * Redactable objects can provide different representations of themselves based on
 * the current execution context. This is useful for sensitive data that should
 * be hidden or modified in certain environments (like production logs).
 *
 * @example
 * ```ts
 * import type { ServiceMap } from "effect"
 * import { Redactable } from "effect"
 *
 * class SensitiveData implements Redactable.Redactable {
 *   constructor(private secret: string) {}
 *
 *   [Redactable.symbolRedactable](context: ServiceMap.ServiceMap<never>) {
 *     // In production, hide the actual secret
 *     return { secret: "[REDACTED]" }
 *   }
 * }
 *
 * const data = new SensitiveData("my-secret-key")
 * // The redacted version will be used when converting to JSON in certain contexts
 * ```
 *
 * @since 4.0.0
 * @category Model
 */
export interface Redactable {
  readonly [symbolRedactable]: (context: ServiceMap.ServiceMap<never>) => unknown
}

/**
 * Checks if a value implements the `Redactable` interface.
 *
 * This function determines whether a given value has redaction capabilities,
 * meaning it can provide alternative representations based on context.
 *
 * @param u - The value to check
 *
 * @example
 * ```ts
 * import { Redactable } from "effect"
 *
 * class RedactableSecret {
 *   [Redactable.symbolRedactable]() {
 *     return "[REDACTED]"
 *   }
 * }
 *
 * const secret = new RedactableSecret()
 * const normal = { value: 42 }
 *
 * console.log(Redactable.isRedactable(secret)) // true
 * console.log(Redactable.isRedactable(normal)) // false
 * console.log(Redactable.isRedactable("string")) // false
 * ```
 *
 * @since 4.0.0
 * @category redactable
 */
export const isRedactable = (u: unknown): u is Redactable => hasProperty(u, symbolRedactable)

/**
 * Applies redaction to a value if it implements the Redactable interface.
 *
 * This function checks if the value is redactable and applies the redaction
 * transformation if a current fiber context is available. Otherwise, it returns
 * the value unchanged.
 *
 * @param u - The value to potentially redact
 *
 * @example
 * ```ts
 * import { Redactable } from "effect"
 *
 * class CreditCard {
 *   constructor(private number: string) {}
 *
 *   [Redactable.symbolRedactable]() {
 *     return {
 *       number: this.number.slice(0, 4) + "****"
 *     }
 *   }
 * }
 *
 * const card = new CreditCard("1234567890123456")
 * console.log(Redactable.redact(card)) // { number: "1234****" }
 *
 * // Non-redactable values are returned unchanged
 * console.log(Redactable.redact("normal string")) // "normal string"
 * console.log(Redactable.redact({ id: 123 })) // { id: 123 }
 * ```
 *
 * @since 4.0.0
 */
export function redact(u: unknown): unknown {
  if (isRedactable(u)) return getRedacted(u)
  return u
}

/**
 * @since 4.0.0
 */
export function getRedacted(redactable: Redactable): unknown {
  return redactable[symbolRedactable]((globalThis as any)[currentFiberTypeId]?.services ?? emptyServiceMap)
}

/** @internal */
export const currentFiberTypeId = "~effect/Fiber/currentFiber"

const emptyServiceMap: ServiceMap.ServiceMap<never> = {
  "~effect/ServiceMap": {} as any,
  mapUnsafe: new Map(),
  pipe() {
    return pipeArguments(this, arguments)
  }
} as any
