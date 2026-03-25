/**
 * @since 2.0.0
 */
import type { NonEmptyReadonlyArray } from "./Array.ts"
import * as Cause from "./Cause.ts"
import * as Effect from "./Effect.ts"
import * as Exit from "./Exit.ts"
import type * as Pull from "./Pull.ts"

/**
 * @since 2.0.0
 * @category Models
 */
export type Take<A, E = never, Done = void> = NonEmptyReadonlyArray<A> | Exit.Exit<Done, E>

/**
 * @since 4.0.0
 * @category Conversions
 */
export const toPull = <A, E, Done>(take: Take<A, E, Done>): Pull.Pull<NonEmptyReadonlyArray<A>, E, Done> =>
  Exit.isExit(take)
    ? Exit.isSuccess(take) ? Cause.done(take.value) : (take as Exit.Exit<never, E>)
    : Effect.succeed(take)
