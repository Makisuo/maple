/**
 * @since 1.0.0
 */
import type * as Effect from "effect/Effect"
import { makeRunMain, type Teardown } from "effect/Runtime"

/**
 * @since 1.0.0
 * @category Runtime
 */
export const runMain: {
  (
    options?: {
      readonly disableErrorReporting?: boolean | undefined
      readonly teardown?: Teardown | undefined
    }
  ): <E, A>(effect: Effect.Effect<A, E>) => void
  <E, A>(
    effect: Effect.Effect<A, E>,
    options?: {
      readonly disableErrorReporting?: boolean | undefined
      readonly teardown?: Teardown | undefined
    }
  ): void
} = makeRunMain(({ fiber }) => {
  globalThis.addEventListener("beforeunload", () => {
    fiber.interruptUnsafe(fiber.id)
  })
})
