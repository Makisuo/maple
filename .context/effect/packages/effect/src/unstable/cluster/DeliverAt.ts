/**
 * @since 4.0.0
 */
import type { DateTime } from "../../DateTime.ts"
import { hasProperty } from "../../Predicate.ts"

/**
 * @since 4.0.0
 * @category symbols
 */
export const symbol = "~effect/cluster/DeliverAt"

/**
 * @since 4.0.0
 * @category models
 */
export interface DeliverAt {
  [symbol](): DateTime
}

/**
 * @since 4.0.0
 * @category guards
 */
export const isDeliverAt = (self: unknown): self is DeliverAt => hasProperty(self, symbol)

/**
 * @since 4.0.0
 * @category accessors
 */
export const toMillis = (self: unknown): number | null => {
  if (isDeliverAt(self)) {
    return self[symbol]().epochMilliseconds
  }
  return null
}
