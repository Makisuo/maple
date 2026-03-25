/**
 * Structured representation of how an Effect can fail.
 *
 * A `Cause<E>` holds a flat array of `Reason` values, where each reason is one of:
 *
 * - **Fail** — a typed, expected error `E` (created by `Effect.fail`)
 * - **Die** — an untyped defect (`unknown`) from `Effect.die` or uncaught throws
 * - **Interrupt** — a fiber interruption, optionally carrying the interrupting fiber's ID
 *
 * ## Mental model
 *
 * - A `Cause` is always flat: concurrent and sequential failures are stored together
 *   in `cause.reasons` (a `ReadonlyArray<Reason<E>>`).
 * - Each `Reason` carries an `annotations` map with tracing metadata (stack frames, spans).
 * - An empty `reasons` array means the computation succeeded or the cause was empty
 *   ({@link empty}).
 * - `Cause` implements `Equal`, so two causes with identical reasons compare as equal.
 *
 * ## Common tasks
 *
 * | Intent | API |
 * |--------|-----|
 * | Create a cause | {@link fail}, {@link die}, {@link interrupt}, {@link fromReasons} |
 * | Test for reason types | {@link hasFails}, {@link hasDies}, {@link hasInterrupts} |
 * | Extract the first error/defect | {@link findError}, {@link findDefect}, {@link findFail}, {@link findDie} |
 * | Iterate over reasons manually | `cause.reasons.filter(Cause.isFailReason)` |
 * | Combine two causes | {@link combine} |
 * | Transform errors | {@link map} |
 * | Collapse to a single thrown value | {@link squash} |
 * | Render for logging | {@link pretty}, {@link prettyErrors} |
 * | Attach/read tracing metadata | {@link annotate}, {@link annotations}, {@link reasonAnnotations} |
 *
 * ## Gotchas
 *
 * - `findError`/`findDefect` return `Filter.fail` (not `Option.none`) when no match is
 *   found. Use {@link findErrorOption} if you need an `Option`.
 * - `squash` picks the first `Fail` error, then the first `Die` defect, then falls back
 *   to a generic "interrupted" / "empty" error. It is lossy — use `prettyErrors` or
 *   iterate `reasons` directly when you need all failures.
 * - The module also exports several built-in error classes (`NoSuchElementError`,
 *   `TimeoutError`, `IllegalArgumentError`, `ExceededCapacityError`, `UnknownError`)
 *   and the `Done` completion signal. These all implement `YieldableError` and can be
 *   yielded directly inside `Effect.gen`.
 *
 * **Example** (inspecting a concurrent failure)
 *
 * ```ts
 * import { Cause, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const cause = yield* Effect.sandbox(
 *     Effect.all([
 *       Effect.fail("err1"),
 *       Effect.die("defect"),
 *       Effect.fail("err2")
 *     ], { concurrency: "unbounded" })
 *   ).pipe(Effect.flip)
 *
 *   const errors = cause.reasons
 *     .filter(Cause.isFailReason)
 *     .map((r) => r.error)
 *
 *   const defects = cause.reasons
 *     .filter(Cause.isDieReason)
 *     .map((r) => r.defect)
 *
 *   console.log(errors)  // ["err1", "err2"]  (order may vary)
 *   console.log(defects) // ["defect"]
 * })
 *
 * Effect.runPromise(program)
 * ```
 *
 * @see {@link Cause} — the core interface
 * @see {@link Reason} — the union of failure kinds
 * @see {@link pretty} — human-readable rendering
 *
 * @since 2.0.0
 */
import type * as Effect from "./Effect.ts"
import type { Equal } from "./Equal.ts"
import type { Fiber } from "./Fiber.ts"
import type { Inspectable } from "./Inspectable.ts"
import * as core from "./internal/core.ts"
import * as effect from "./internal/effect.ts"
import type { Option } from "./Option.ts"
import type { Pipeable } from "./Pipeable.ts"
import type { StackFrame } from "./References.ts"
import type * as Result from "./Result.ts"
import * as ServiceMap from "./ServiceMap.ts"
import type * as Types from "./Types.ts"

/**
 * Unique brand for `Cause` values, used for runtime type checks via {@link isCause}.
 *
 * @since 2.0.0
 * @category symbols
 */
export const TypeId: "~effect/Cause" = core.CauseTypeId

/**
 * Unique brand for `Reason` values, used for runtime type checks via {@link isReason}.
 *
 * @since 2.0.0
 * @category symbols
 */
export const ReasonTypeId: "~effect/Cause/Reason" = core.CauseReasonTypeId

/**
 * A structured representation of how an Effect failed.
 *
 * Access the individual failure entries through the `reasons` array, then
 * narrow each entry with {@link isFailReason}, {@link isDieReason}, or
 * {@link isInterruptReason}.
 *
 * - Use {@link hasFails} / {@link hasDies} / {@link hasInterrupts} to test
 *   for the presence of specific reason kinds without iterating.
 * - Use {@link findError} / {@link findDefect} to extract the first value
 *   of a given kind.
 * - Use {@link combine} to merge two causes.
 *
 * `Cause` implements `Equal` — two causes with the same reasons (by value)
 * compare as equal.
 *
 * **Example** (creating and inspecting a cause)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.fail("Something went wrong")
 * console.log(cause.reasons.length) // 1
 * console.log(Cause.isFailReason(cause.reasons[0])) // true
 * ```
 *
 * @see {@link Reason} — the union type stored in `reasons`
 *
 * @since 2.0.0
 * @category models
 */
export interface Cause<out E> extends Pipeable, Inspectable, Equal {
  readonly [TypeId]: typeof TypeId
  readonly reasons: ReadonlyArray<Reason<E>>
}

/**
 * Tests if an arbitrary value is a {@link Cause}.
 *
 * **Example** (runtime type check)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * console.log(Cause.isCause(Cause.fail("error"))) // true
 * console.log(Cause.isCause("not a cause")) // false
 * ```
 *
 * @category guards
 * @since 2.0.0
 */
export const isCause: (self: unknown) => self is Cause<unknown> = core.isCause

/**
 * Tests if an arbitrary value is a {@link Reason} (`Fail`, `Die`, or `Interrupt`).
 *
 * **Example** (runtime type check)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const reason = Cause.fail("error").reasons[0]
 * console.log(Cause.isReason(reason)) // true
 * console.log(Cause.isReason("not a reason")) // false
 * ```
 *
 * @category guards
 * @since 2.0.0
 */
export const isReason: (self: unknown) => self is Reason<unknown> = core.isCauseReason

/**
 * A single entry inside a {@link Cause}'s `reasons` array.
 *
 * Narrow to a concrete type with {@link isFailReason}, {@link isDieReason},
 * or {@link isInterruptReason}.
 *
 * - `Fail<E>` — typed error, access via `.error`
 * - `Die` — untyped defect, access via `.defect`
 * - `Interrupt` — fiber interruption, access via `.fiberId`
 *
 * Every reason carries an `annotations` map and an `annotate` method for
 * attaching tracing metadata.
 *
 * **Example** (narrowing a reason)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const reason = Cause.fail("error").reasons[0]
 * if (Cause.isFailReason(reason)) {
 *   console.log(reason.error) // "error"
 * }
 * ```
 *
 * @see {@link Fail} — typed error reason
 * @see {@link Die} — untyped defect reason
 * @see {@link Interrupt} — interruption reason
 *
 * @since 4.0.0
 * @category models
 */
export type Reason<E> = Fail<E> | Die | Interrupt

/**
 * Narrows a {@link Reason} to {@link Fail}.
 *
 * Useful as a predicate for `Array.filter` when iterating over `cause.reasons`.
 *
 * **Example** (filtering fail reasons)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.fail("error")
 * const fails = cause.reasons.filter(Cause.isFailReason)
 * console.log(fails[0].error) // "error"
 * ```
 *
 * @see {@link isDieReason} — narrow to `Die`
 * @see {@link isInterruptReason} — narrow to `Interrupt`
 *
 * @category guards
 * @since 4.0.0
 */
export const isFailReason: <E>(self: Reason<E>) => self is Fail<E> = core.isFailReason

/**
 * Narrows a {@link Reason} to {@link Die}.
 *
 * Useful as a predicate for `Array.filter` when iterating over `cause.reasons`.
 *
 * **Example** (filtering die reasons)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.die("defect")
 * const dies = cause.reasons.filter(Cause.isDieReason)
 * console.log(dies[0].defect) // "defect"
 * ```
 *
 * @see {@link isFailReason} — narrow to `Fail`
 * @see {@link isInterruptReason} — narrow to `Interrupt`
 *
 * @category guards
 * @since 4.0.0
 */
export const isDieReason: <E>(self: Reason<E>) => self is Die = core.isDieReason

/**
 * Narrows a {@link Reason} to {@link Interrupt}.
 *
 * Useful as a predicate for `Array.filter` when iterating over `cause.reasons`.
 *
 * **Example** (filtering interrupt reasons)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.interrupt(123)
 * const interrupts = cause.reasons.filter(Cause.isInterruptReason)
 * console.log(interrupts[0].fiberId) // 123
 * ```
 *
 * @see {@link isFailReason} — narrow to `Fail`
 * @see {@link isDieReason} — narrow to `Die`
 *
 * @category guards
 * @since 4.0.0
 */
export const isInterruptReason: <E>(self: Reason<E>) => self is Interrupt = core.isInterruptReason

/**
 * Companion namespace for the {@link Cause} interface.
 *
 * @since 2.0.0
 * @category models
 */
export declare namespace Cause {
  /**
   * Extracts the error type `E` from a `Cause<E>`.
   *
   * **Example** (extracting the error type)
   *
   * ```ts
   * import type { Cause } from "effect"
   *
   * // string
   * type E = Cause.Cause.Error<Cause.Cause<string>>
   * ```
   *
   * @since 4.0.0
   * @category models
   */
  export type Error<T> = T extends Cause<infer E> ? E : never

  /**
   * Base interface shared by all reason types ({@link Fail}, {@link Die},
   * {@link Interrupt}).
   *
   * Every reason carries:
   * - `_tag` — discriminant string (`"Fail"`, `"Die"`, or `"Interrupt"`)
   * - `annotations` — tracing metadata attached by the runtime
   * - `annotate()` — returns a copy with additional annotations
   *
   * @since 4.0.0
   * @category models
   */
  export interface ReasonProto<Tag extends string> extends Inspectable, Equal {
    readonly [ReasonTypeId]: typeof ReasonTypeId
    readonly _tag: Tag
    readonly annotations: ReadonlyMap<string, unknown>
    annotate(annotations: ServiceMap.ServiceMap<never> | ReadonlyMap<string, unknown>, options?: {
      readonly overwrite?: boolean | undefined
    }): this
  }
}

/**
 * Companion namespace for the {@link Reason} type.
 *
 * @since 2.0.0
 * @category models
 */
export declare namespace Reason {
  /**
   * Extracts the error type `E` from a `Reason<E>`.
   *
   * **Example** (extracting the error type)
   *
   * ```ts
   * import type { Cause } from "effect"
   *
   * // string
   * type E = Cause.Reason.Error<Cause.Reason<string>>
   * ```
   *
   * @since 4.0.0
   * @category models
   */
  export type Error<T> = T extends Reason<infer E> ? E : never
}

/**
 * An untyped defect — typically a programming error or an uncaught exception.
 *
 * The `defect` property is `unknown` because defects are not part of the
 * typed error channel. Use {@link isDieReason} to narrow a {@link Reason}
 * to this type.
 *
 * **Example** (accessing the defect)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.die(new Error("Unexpected"))
 * const reason = cause.reasons[0]
 * if (Cause.isDieReason(reason)) {
 *   console.log(reason.defect) // Error: Unexpected
 * }
 * ```
 *
 * @see {@link die} — create a `Cause` containing a single `Die`
 * @see {@link isDieReason} — type guard
 *
 * @since 2.0.0
 * @category models
 */
export interface Die extends Cause.ReasonProto<"Die"> {
  readonly defect: unknown
}

/**
 * A typed, expected error produced by `Effect.fail`.
 *
 * The `error` property carries the typed value `E`. Use {@link isFailReason}
 * to narrow a {@link Reason} to this type.
 *
 * **Example** (accessing the error)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.fail("Something went wrong")
 * const reason = cause.reasons[0]
 * if (Cause.isFailReason(reason)) {
 *   console.log(reason.error) // "Something went wrong"
 * }
 * ```
 *
 * @see {@link fail} — create a `Cause` containing a single `Fail`
 * @see {@link isFailReason} — type guard
 *
 * @since 2.0.0
 * @category models
 */
export interface Fail<out E> extends Cause.ReasonProto<"Fail"> {
  readonly error: E
}

/**
 * A fiber interruption signal, optionally carrying the ID of the fiber that
 * initiated the interruption.
 *
 * Use {@link isInterruptReason} to narrow a {@link Reason} to this type.
 *
 * **Example** (accessing the fiber ID)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.interrupt(123)
 * const reason = cause.reasons[0]
 * if (Cause.isInterruptReason(reason)) {
 *   console.log(reason.fiberId) // 123
 * }
 * ```
 *
 * @see {@link interrupt} — create a `Cause` containing a single `Interrupt`
 * @see {@link isInterruptReason} — type guard
 *
 * @since 2.0.0
 * @category models
 */
export interface Interrupt extends Cause.ReasonProto<"Interrupt"> {
  readonly fiberId: number | undefined
}

/**
 * Creates a {@link Cause} from an array of {@link Reason} values.
 *
 * Use this when you already have individual reasons (e.g. from filtering or
 * transforming another cause's `reasons` array) and need to wrap them back
 * into a `Cause`.
 *
 * - Returns a new `Cause`; does not mutate the input array.
 * - An empty array produces a cause equivalent to {@link empty}.
 *
 * **Example** (building a cause from reasons)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const reasons = [
 *   Cause.makeFailReason("err1"),
 *   Cause.makeFailReason("err2")
 * ]
 * const cause = Cause.fromReasons(reasons)
 * console.log(cause.reasons.length) // 2
 * ```
 *
 * @see {@link combine} — merge two existing causes
 *
 * @category constructors
 * @since 2.0.0
 */
export const fromReasons: <E>(
  reasons: ReadonlyArray<Reason<E>>
) => Cause<E> = core.causeFromReasons

/**
 * A {@link Cause} with an empty `reasons` array.
 *
 * Represents the absence of failure. Combining any cause with `empty` via
 * {@link combine} returns the original cause unchanged.
 *
 * @see {@link combine}
 *
 * @category constructors
 * @since 2.0.0
 */
export const empty: Cause<never> = core.causeEmpty

/**
 * Creates a {@link Cause} containing a single {@link Fail} reason with the
 * given typed error.
 *
 * **Example** (creating a fail cause)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.fail("Something went wrong")
 * console.log(cause.reasons.length) // 1
 * console.log(Cause.isFailReason(cause.reasons[0])) // true
 * ```
 *
 * @see {@link die} — for untyped defects
 * @see {@link interrupt} — for fiber interruptions
 *
 * @category constructors
 * @since 2.0.0
 */
export const fail: <E>(error: E) => Cause<E> = core.causeFail

/**
 * Creates a {@link Cause} containing a single {@link Die} reason with the
 * given defect.
 *
 * **Example** (creating a die cause)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.die(new Error("Unexpected"))
 * console.log(cause.reasons.length) // 1
 * console.log(Cause.isDieReason(cause.reasons[0])) // true
 * ```
 *
 * @see {@link fail} — for typed errors
 * @see {@link interrupt} — for fiber interruptions
 *
 * @category constructors
 * @since 2.0.0
 */
export const die: (defect: unknown) => Cause<never> = core.causeDie

/**
 * Creates a {@link Cause} containing a single {@link Interrupt} reason,
 * optionally carrying the interrupting fiber's ID.
 *
 * **Example** (creating an interrupt cause)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.interrupt(123)
 * console.log(cause.reasons.length) // 1
 * console.log(Cause.isInterruptReason(cause.reasons[0])) // true
 * ```
 *
 * @see {@link fail} — for typed errors
 * @see {@link die} — for untyped defects
 *
 * @category constructors
 * @since 2.0.0
 */
export const interrupt: (fiberId?: number | undefined) => Cause<never> = effect.causeInterrupt

/**
 * Creates a standalone {@link Fail} reason (not wrapped in a {@link Cause}).
 *
 * Use this when you need to construct individual reasons for
 * {@link fromReasons} or for direct comparison.
 *
 * **Example** (creating a Fail reason)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const reason = Cause.makeFailReason("error")
 * console.log(reason._tag) // "Fail"
 * console.log(reason.error) // "error"
 * ```
 *
 * @see {@link makeDieReason} — create a `Die` reason
 * @see {@link makeInterruptReason} — create an `Interrupt` reason
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeFailReason = <E>(error: E): Fail<E> => new core.Fail(error)

/**
 * Creates a standalone {@link Die} reason (not wrapped in a {@link Cause}).
 *
 * **Example** (creating a Die reason)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const reason = Cause.makeDieReason(new Error("bug"))
 * console.log(reason._tag) // "Die"
 * ```
 *
 * @see {@link makeFailReason} — create a `Fail` reason
 * @see {@link makeInterruptReason} — create an `Interrupt` reason
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeDieReason = (defect: unknown): Die => new core.Die(defect)

/**
 * Creates a standalone {@link Interrupt} reason (not wrapped in a {@link Cause}),
 * optionally carrying the interrupting fiber's ID.
 *
 * **Example** (creating an Interrupt reason)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const reason = Cause.makeInterruptReason(42)
 * console.log(reason._tag) // "Interrupt"
 * console.log(reason.fiberId) // 42
 * ```
 *
 * @see {@link makeFailReason} — create a `Fail` reason
 * @see {@link makeDieReason} — create a `Die` reason
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeInterruptReason: (fiberId?: number | undefined) => Interrupt = effect.makeInterruptReason

/**
 * Returns `true` if every reason in the cause is an {@link Interrupt} (and
 * there is at least one reason).
 *
 * Useful for deciding whether a failure was entirely due to interruption and
 * can be silently discarded.
 *
 * **Example** (checking interrupt-only causes)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * console.log(Cause.hasInterruptsOnly(Cause.interrupt(123))) // true
 * console.log(Cause.hasInterruptsOnly(Cause.fail("error")))  // false
 * console.log(Cause.hasInterruptsOnly(Cause.empty))          // false
 * ```
 *
 * @see {@link hasInterrupts} — `true` if the cause contains *any* interrupts
 *
 * @category predicates
 * @since 2.0.0
 */
export const hasInterruptsOnly: <E>(self: Cause<E>) => boolean = effect.hasInterruptsOnly

/**
 * Transforms the typed error values inside a {@link Cause} using the
 * provided function. Only {@link Fail} reasons are affected; {@link Die}
 * and {@link Interrupt} reasons pass through unchanged.
 *
 * Returns a new `Cause`; does not mutate the original.
 *
 * **Example** (mapping errors to uppercase)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.fail("error")
 * const mapped = Cause.map(cause, (e) => e.toUpperCase())
 * const reason = mapped.reasons[0]
 * if (Cause.isFailReason(reason)) {
 *   console.log(reason.error) // "ERROR"
 * }
 * ```
 *
 * @category mapping
 * @since 4.0.0
 */
export const map: {
  <E, E2>(f: (error: Types.NoInfer<E>) => E2): (self: Cause<E>) => Cause<E2>
  <E, E2>(self: Cause<E>, f: (error: Types.NoInfer<E>) => E2): Cause<E2>
} = effect.causeMap

/**
 * Merges two causes into a single cause whose `reasons` array is the union
 * of both inputs (de-duplicated by value equality).
 *
 * - Combining with {@link empty} returns the other cause unchanged.
 * - If the result is structurally equal to `self`, `self` is returned
 *   (referential shortcut).
 *
 * **Example** (combining two causes)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause1 = Cause.fail("error1")
 * const cause2 = Cause.fail("error2")
 * const combined = Cause.combine(cause1, cause2)
 * console.log(combined.reasons.length) // 2
 * ```
 *
 * @see {@link fromReasons} — build a cause from an array of reasons
 *
 * @category combining
 * @since 4.0.0
 */
export const combine: {
  <E2>(that: Cause<E2>): <E>(self: Cause<E>) => Cause<E | E2>
  <E, E2>(self: Cause<E>, that: Cause<E2>): Cause<E | E2>
} = effect.causeCombine

/**
 * Collapses a {@link Cause} into a single `unknown` value, picking the "most
 * important" failure in this order:
 *
 * 1. First {@link Fail} error (the `E` value)
 * 2. First {@link Die} defect
 * 3. A generic `Error("All fibers interrupted without error")` for interrupt-only causes
 * 4. A generic `Error("Empty cause")` for {@link empty}
 *
 * This is the function used by `Effect.runPromise` and `Effect.runSync` to
 * decide what to throw. It is lossy — use {@link prettyErrors} or iterate
 * `cause.reasons` when you need all failures.
 *
 * **Example** (squashing a cause)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * console.log(Cause.squash(Cause.fail("error")))    // "error"
 * console.log(Cause.squash(Cause.die("defect")))    // "defect"
 * ```
 *
 * @see {@link prettyErrors} — non-lossy conversion to `Array<Error>`
 * @see {@link pretty} — human-readable string rendering
 *
 * @category destructors
 * @since 2.0.0
 */
export const squash: <E>(self: Cause<E>) => unknown = effect.causeSquash

/**
 * Returns `true` if the cause contains at least one {@link Fail} reason.
 *
 * **Example** (checking for typed errors)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * console.log(Cause.hasFails(Cause.fail("error"))) // true
 * console.log(Cause.hasFails(Cause.die("defect"))) // false
 * ```
 *
 * @see {@link hasDies} — check for defects
 * @see {@link hasInterrupts} — check for interruptions
 *
 * @category predicates
 * @since 2.0.0
 */
export const hasFails: <E>(self: Cause<E>) => boolean = effect.hasFails

/**
 * Returns the first {@link Fail} reason from a cause, including its
 * annotations. Returns `Filter.fail` with the remaining cause when no
 * `Fail` is found.
 *
 * Use {@link findError} if you only need the unwrapped error value `E`.
 *
 * **Example** (extracting the first Fail reason)
 *
 * ```ts
 * import { Cause, Result } from "effect"
 *
 * const result = Cause.findFail(Cause.fail("error"))
 * if (!Result.isFailure(result)) {
 *   console.log(result.success.error) // "error"
 * }
 * ```
 *
 * @see {@link findError} — extract the unwrapped `E` value
 * @see {@link findDie} — extract the first `Die` reason
 *
 * @category filters
 * @since 4.0.0
 */
export const findFail: <E>(self: Cause<E>) => Result.Result<Fail<E>, Cause<never>> = effect.findFail

/**
 * Returns the first typed error value `E` from a cause.
 * Returns `Filter.fail` with the remaining cause when no `Fail` is found.
 *
 * Use {@link findFail} if you need the full {@link Fail} reason (including
 * annotations). Use {@link findErrorOption} if you prefer an `Option`.
 *
 * **Example** (extracting the first error value)
 *
 * ```ts
 * import { Cause, Result } from "effect"
 *
 * const result = Cause.findError(Cause.fail("error"))
 * if (!Result.isFailure(result)) {
 *   console.log(result.success) // "error"
 * }
 * ```
 *
 * @see {@link findFail} — extract the full `Fail` reason
 * @see {@link findErrorOption} — `Option`-based variant
 *
 * @category filters
 * @since 4.0.0
 */
export const findError: <E>(self: Cause<E>) => Result.Result<E, Cause<never>> = effect.findError

/**
 * Returns the first typed error value `E` from a cause wrapped in
 * `Option.some`, or `Option.none` if no {@link Fail} reason exists.
 *
 * This is a convenience wrapper around {@link findError} for code that
 * already works with `Option` instead of `Filter`.
 *
 * **Example** (extracting an error as Option)
 *
 * ```ts
 * import { Cause, Option } from "effect"
 *
 * const some = Cause.findErrorOption(Cause.fail("error"))
 * console.log(Option.isSome(some)) // true
 *
 * const none = Cause.findErrorOption(Cause.die("defect"))
 * console.log(Option.isNone(none)) // true
 * ```
 *
 * @see {@link findError} — `Filter`-based variant
 *
 * @category filters
 * @since 4.0.0
 */
export const findErrorOption: <E>(input: Cause<E>) => Option<E> = effect.findErrorOption

/**
 * Returns `true` if the cause contains at least one {@link Die} reason.
 *
 * **Example** (checking for defects)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * console.log(Cause.hasDies(Cause.die("defect"))) // true
 * console.log(Cause.hasDies(Cause.fail("error"))) // false
 * ```
 *
 * @see {@link hasFails} — check for typed errors
 * @see {@link hasInterrupts} — check for interruptions
 *
 * @category predicates
 * @since 2.0.0
 */
export const hasDies: <E>(self: Cause<E>) => boolean = effect.hasDies

/**
 * Returns the first {@link Die} reason from a cause, including its
 * annotations. Returns `Filter.fail` with the original cause when no
 * `Die` is found.
 *
 * Use {@link findDefect} if you only need the unwrapped defect value.
 *
 * **Example** (extracting the first Die reason)
 *
 * ```ts
 * import { Cause, Result } from "effect"
 *
 * const result = Cause.findDie(Cause.die("defect"))
 * if (!Result.isFailure(result)) {
 *   console.log(result.success.defect) // "defect"
 * }
 * ```
 *
 * @see {@link findDefect} — extract the unwrapped defect value
 * @see {@link findFail} — extract the first `Fail` reason
 *
 * @category filters
 * @since 4.0.0
 */
export const findDie: <E>(self: Cause<E>) => Result.Result<Die, Cause<E>> = effect.findDie

/**
 * Returns the first defect value (`unknown`) from a cause.
 * Returns `Filter.fail` with the original cause when no {@link Die} reason
 * is found.
 *
 * Use {@link findDie} if you need the full `Die` reason (including
 * annotations).
 *
 * **Example** (extracting the first defect)
 *
 * ```ts
 * import { Cause, Result } from "effect"
 *
 * const result = Cause.findDefect(Cause.die("defect"))
 * if (!Result.isFailure(result)) {
 *   console.log(result.success) // "defect"
 * }
 * ```
 *
 * @see {@link findDie} — extract the full `Die` reason
 * @see {@link findError} — extract the first typed error
 *
 * @category filters
 * @since 4.0.0
 */
export const findDefect: <E>(self: Cause<E>) => Result.Result<unknown, Cause<E>> = effect.findDefect

/**
 * Returns `true` if the cause contains at least one {@link Interrupt} reason.
 *
 * **Example** (checking for interruptions)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * console.log(Cause.hasInterrupts(Cause.interrupt(123))) // true
 * console.log(Cause.hasInterrupts(Cause.fail("error")))  // false
 * ```
 *
 * @see {@link hasInterruptsOnly} — `true` only when *all* reasons are interrupts
 * @see {@link hasFails} — check for typed errors
 * @see {@link hasDies} — check for defects
 *
 * @category predicates
 * @since 2.0.0
 */
export const hasInterrupts: <E>(self: Cause<E>) => boolean = effect.hasInterrupts

/**
 * Returns the first {@link Interrupt} reason from a cause, including its
 * annotations. Returns `Filter.fail` with the original cause when no
 * `Interrupt` is found.
 *
 * **Example** (extracting the first interrupt)
 *
 * ```ts
 * import { Cause, Result } from "effect"
 *
 * const result = Cause.findInterrupt(Cause.interrupt(42))
 * if (!Result.isFailure(result)) {
 *   console.log(result.success.fiberId) // 42
 * }
 * ```
 *
 * @see {@link interruptors} — collect all interrupting fiber IDs as a `Set`
 *
 * @category filters
 * @since 4.0.0
 */
export const findInterrupt: <E>(self: Cause<E>) => Result.Result<Interrupt, Cause<E>> = effect.findInterrupt

/**
 * Collects the fiber IDs of all {@link Interrupt} reasons in the cause into
 * a `ReadonlySet`. Returns an empty set when the cause has no interrupts.
 *
 * This always succeeds (no `Filter.fail`). Use {@link filterInterruptors}
 * for the `Filter`-based variant.
 *
 * **Example** (collecting interruptors)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.combine(
 *   Cause.interrupt(1),
 *   Cause.interrupt(2)
 * )
 * console.log(Cause.interruptors(cause)) // Set { 1, 2 }
 * ```
 *
 * @see {@link filterInterruptors} — `Filter`-based variant
 *
 * @category accessors
 * @since 4.0.0
 */
export const interruptors: <E>(self: Cause<E>) => ReadonlySet<number> = effect.causeInterruptors

/**
 * Extracts the set of interrupting fiber IDs from a cause.
 * Returns `Filter.fail` with the original cause when no {@link Interrupt}
 * reason is found.
 *
 * Use {@link interruptors} if you always want a `Set` (possibly empty)
 * without `Filter` wrapping.
 *
 * **Example** (extracting interruptors with Filter)
 *
 * ```ts
 * import { Cause, Result } from "effect"
 *
 * const result = Cause.filterInterruptors(Cause.interrupt(1))
 * if (!Result.isFailure(result)) {
 *   console.log(result.success) // Set { 1 }
 * }
 * ```
 *
 * @see {@link interruptors} — always-succeeding variant
 *
 * @category filters
 * @since 4.0.0
 */
export const filterInterruptors: <E>(self: Cause<E>) => Result.Result<Set<number>, Cause<E>> =
  effect.causeFilterInterruptors

/**
 * Converts a {@link Cause} into an `Array<Error>` suitable for logging or
 * rethrowing.
 *
 * Each {@link Fail} and {@link Die} reason is converted into a standard
 * `Error`:
 *
 * - **Objects / Error instances** — `message`, `name`, `stack`, and `cause`
 *   are preserved. Extra enumerable properties are copied. Stack traces are
 *   cleaned up and enriched with span annotations when available.
 * - **Strings** — used directly as the `Error` message.
 * - **Other primitives** (`null`, `undefined`, numbers, …) — wrapped in an
 *   `Error` with message `"Unknown error: <value>"`.
 *
 * {@link Interrupt} reasons are collected separately. If the cause contains
 * **only** interrupts (no `Fail` or `Die`), a single `InterruptError` is
 * returned whose `cause` lists the interrupting fiber IDs.
 *
 * **Example** (converting a cause to errors)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.fail(new Error("boom"))
 * const errors = Cause.prettyErrors(cause)
 * console.log(errors[0].message) // "boom"
 * ```
 *
 * @see {@link pretty} — renders the cause as a single string
 * @see {@link squash} — lossy collapse to a single thrown value
 *
 * @since 4.0.0
 * @category rendering
 */
export const prettyErrors: <E>(self: Cause<E>) => Array<Error> = effect.causePrettyErrors

/**
 * Renders a {@link Cause} as a human-readable string for logging or
 * debugging.
 *
 * Delegates to {@link prettyErrors} to convert each reason to an `Error`,
 * then joins their stack traces with newlines. Nested `Error.cause` chains
 * are rendered inline with indentation:
 *
 * ```text
 * ErrorName: message
 *     at ...
 *     at ... {
 *   [cause]: NestedError: message
 *       at ...
 * }
 * ```
 *
 * Span annotations are appended to the relevant stack frames when available.
 *
 * **Example** (rendering a cause)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.fail("something went wrong")
 * console.log(Cause.pretty(cause))
 * // Error: something went wrong
 * //     at ...
 * ```
 *
 * @see {@link prettyErrors} — get the individual `Error` instances
 *
 * @since 4.0.0
 * @category rendering
 */
export const pretty: <E>(cause: Cause<E>) => string = effect.causePretty

/**
 * Base interface for error classes that can be yielded directly inside
 * `Effect.gen` (via `Symbol.iterator`) or converted to a failing Effect
 * via `.asEffect()`.
 *
 * All built-in error classes in this module ({@link NoSuchElementError},
 * {@link TimeoutError}, {@link IllegalArgumentError},
 * {@link ExceededCapacityError}, {@link UnknownError}) extend this
 * interface.
 *
 * **Example** (yielding an error in Effect.gen)
 *
 * ```ts
 * import { Cause, Effect } from "effect"
 *
 * const error = new Cause.NoSuchElementError("not found")
 *
 * const program = Effect.gen(function*() {
 *   return yield* error // fails the effect with NoSuchElementError
 * })
 * ```
 *
 * @since 2.0.0
 * @category errors
 */
export interface YieldableError extends Error, Pipeable {
  [Symbol.iterator](): Effect.EffectIterator<this>
  asEffect(): Effect.Effect<never, this, never>
}

/**
 * Tests if an arbitrary value is a {@link NoSuchElementError}.
 *
 * **Example** (runtime type check)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * console.log(Cause.isNoSuchElementError(new Cause.NoSuchElementError())) // true
 * console.log(Cause.isNoSuchElementError("nope")) // false
 * ```
 *
 * @category guards
 * @since 4.0.0
 */
export const isNoSuchElementError: (u: unknown) => u is NoSuchElementError = core.isNoSuchElementError

/**
 * Unique brand for {@link NoSuchElementError}.
 *
 * @since 4.0.0
 * @category symbols
 */
export const NoSuchElementErrorTypeId: "~effect/Cause/NoSuchElementError" = core.NoSuchElementErrorTypeId

/**
 * An error indicating that a requested element does not exist.
 *
 * Thrown by APIs like `Array.head`, `Option.getOrThrow`, `Map.get`, etc.
 * when no element matches. Implements {@link YieldableError} so it can be
 * yielded directly in `Effect.gen`.
 *
 * **Example** (creating and checking)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const error = new Cause.NoSuchElementError("Element not found")
 * console.log(error._tag)    // "NoSuchElementError"
 * console.log(error.message) // "Element not found"
 * ```
 *
 * @see {@link isNoSuchElementError} — type guard
 * @see {@link NoSuchElementError:var | NoSuchElementError constructor}
 *
 * @since 4.0.0
 * @category errors
 */
export interface NoSuchElementError extends YieldableError {
  readonly [NoSuchElementErrorTypeId]: typeof NoSuchElementErrorTypeId
  readonly _tag: "NoSuchElementError"
}

/**
 * Constructs a {@link NoSuchElementError} with an optional message.
 *
 * **Example** (creating a NoSuchElementError)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const error = new Cause.NoSuchElementError("Element not found")
 * console.log(error.message) // "Element not found"
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const NoSuchElementError: new(message?: string) => NoSuchElementError = core.NoSuchElementError

/**
 * Tests if an arbitrary value is a {@link Done} signal.
 *
 * **Example** (runtime type check)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * console.log(Cause.isDone(Cause.Done())) // true
 * console.log(Cause.isDone("not done"))   // false
 * ```
 *
 * @category guards
 * @since 4.0.0
 */
export const isDone: (u: unknown) => u is Done<any> = core.isDone

/**
 * Unique brand for {@link Done} values.
 *
 * @since 4.0.0
 * @category symbols
 */
export const DoneTypeId: "~effect/Cause/Done" = core.DoneTypeId

/**
 * A graceful completion signal for queues and streams.
 *
 * `Done` indicates that a producer has finished normally — no more elements
 * will arrive. It is distinct from an error or interruption; it represents
 * successful completion. The optional `value` field can carry a final
 * leftover payload.
 *
 * **Example** (signaling queue completion)
 *
 * ```ts
 * import { Cause, Effect, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number, Cause.Done>(10)
 *   yield* Queue.offer(queue, 1)
 *   yield* Queue.end(queue)
 *
 *   const result = yield* Effect.flip(Queue.take(queue))
 *   console.log(Cause.isDone(result)) // true
 * })
 * ```
 *
 * @see {@link isDone} — type guard
 * @see {@link done} — create a failing Effect with `Done`
 *
 * @since 4.0.0
 * @category errors
 */
export interface Done<A = void> {
  readonly [DoneTypeId]: typeof DoneTypeId
  readonly _tag: "Done"
  readonly value: A
}

/**
 * Companion namespace for the {@link Done} interface.
 *
 * @since 4.0.0
 * @category errors
 */
export declare namespace Done {
  /**
   * Extracts the value type `A` from a `Done<A>` that may be nested in an
   * error union.
   *
   * @since 4.0.0
   */
  export type Extract<E> = E extends Done<infer L> ? L : never

  /**
   * Filters a type union to only keep `Done` members.
   *
   * @since 4.0.0
   */
  export type Only<E> = E extends Done<infer L> ? Done<L> : never
}

/**
 * Creates a {@link Done} signal with an optional value.
 *
 * @see {@link done} — create a failing `Effect` with `Done`
 *
 * @category constructors
 * @since 4.0.0
 */
export const Done: <A = void>(value?: A) => Done<A> = core.Done

/**
 * Creates an Effect that fails with a {@link Done} error. Shorthand for
 * `Effect.fail(Cause.Done(value))`.
 *
 * @see {@link Done:var | Done} — create the signal value without an Effect
 *
 * @category constructors
 * @since 4.0.0
 */
export const done: <A = void>(value?: A) => Effect.Effect<never, Done<A>> = core.done

/**
 * Unique brand for {@link TimeoutError}.
 *
 * @since 4.0.0
 * @category symbols
 */
export const TimeoutErrorTypeId: "~effect/Cause/TimeoutError" = effect.TimeoutErrorTypeId

/**
 * Tests if an arbitrary value is a {@link TimeoutError}.
 *
 * **Example** (runtime type check)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * console.log(Cause.isTimeoutError(new Cause.TimeoutError())) // true
 * console.log(Cause.isTimeoutError("nope")) // false
 * ```
 *
 * @category guards
 * @since 4.0.0
 */
export const isTimeoutError: (u: unknown) => u is TimeoutError = effect.isTimeoutError

/**
 * An error indicating that an operation exceeded its time limit.
 *
 * Produced by `Effect.timeout` and related APIs. Implements
 * {@link YieldableError}.
 *
 * **Example** (creating and checking)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const error = new Cause.TimeoutError("Operation timed out")
 * console.log(error._tag)    // "TimeoutError"
 * console.log(error.message) // "Operation timed out"
 * ```
 *
 * @see {@link isTimeoutError} — type guard
 *
 * @since 4.0.0
 * @category errors
 */
export interface TimeoutError extends YieldableError {
  readonly [TimeoutErrorTypeId]: typeof TimeoutErrorTypeId
  readonly _tag: "TimeoutError"
}

/**
 * Constructs a {@link TimeoutError} with an optional message.
 *
 * **Example** (creating a TimeoutError)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const error = new Cause.TimeoutError("Operation timed out")
 * console.log(error.message) // "Operation timed out"
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const TimeoutError: new(message?: string) => TimeoutError = effect.TimeoutError

/**
 * Unique brand for {@link IllegalArgumentError}.
 *
 * @since 4.0.0
 * @category symbols
 */
export const IllegalArgumentErrorTypeId: "~effect/Cause/IllegalArgumentError" = effect.IllegalArgumentErrorTypeId

/**
 * Tests if an arbitrary value is an {@link IllegalArgumentError}.
 *
 * **Example** (runtime type check)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * console.log(Cause.isIllegalArgumentError(new Cause.IllegalArgumentError())) // true
 * console.log(Cause.isIllegalArgumentError("nope")) // false
 * ```
 *
 * @category guards
 * @since 4.0.0
 */
export const isIllegalArgumentError: (u: unknown) => u is IllegalArgumentError = effect.isIllegalArgumentError

/**
 * An error indicating that a function received an argument that violates
 * its contract (e.g. negative where positive was expected).
 *
 * Implements {@link YieldableError}.
 *
 * **Example** (creating and checking)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const error = new Cause.IllegalArgumentError("Expected positive number")
 * console.log(error._tag)    // "IllegalArgumentError"
 * console.log(error.message) // "Expected positive number"
 * ```
 *
 * @see {@link isIllegalArgumentError} — type guard
 *
 * @since 4.0.0
 * @category errors
 */
export interface IllegalArgumentError extends YieldableError {
  readonly [IllegalArgumentErrorTypeId]: typeof IllegalArgumentErrorTypeId
  readonly _tag: "IllegalArgumentError"
}

/**
 * Constructs an {@link IllegalArgumentError} with an optional message.
 *
 * **Example** (creating an IllegalArgumentError)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const error = new Cause.IllegalArgumentError("Invalid argument")
 * console.log(error.message) // "Invalid argument"
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const IllegalArgumentError: new(message?: string) => IllegalArgumentError = effect.IllegalArgumentError

/**
 * Tests if an arbitrary value is an {@link ExceededCapacityError}.
 *
 * **Example** (runtime type check)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * console.log(Cause.isExceededCapacityError(new Cause.ExceededCapacityError())) // true
 * console.log(Cause.isExceededCapacityError("nope")) // false
 * ```
 *
 * @category guards
 * @since 4.0.0
 */
export const isExceededCapacityError: (u: unknown) => u is ExceededCapacityError = effect.isExceededCapacityError

/**
 * Unique brand for {@link ExceededCapacityError}.
 *
 * @since 4.0.0
 * @category symbols
 */
export const ExceededCapacityErrorTypeId: "~effect/Cause/ExceededCapacityError" = effect.ExceededCapacityErrorTypeId

/**
 * An error indicating that a bounded resource (queue, pool, semaphore, etc.)
 * has exceeded its capacity.
 *
 * Implements {@link YieldableError}.
 *
 * **Example** (creating and checking)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const error = new Cause.ExceededCapacityError("Queue full")
 * console.log(error._tag)    // "ExceededCapacityError"
 * console.log(error.message) // "Queue full"
 * ```
 *
 * @see {@link isExceededCapacityError} — type guard
 *
 * @since 4.0.0
 * @category errors
 */
export interface ExceededCapacityError extends YieldableError {
  readonly [ExceededCapacityErrorTypeId]: typeof ExceededCapacityErrorTypeId
  readonly _tag: "ExceededCapacityError"
}

/**
 * Constructs an {@link ExceededCapacityError} with an optional message.
 *
 * **Example** (creating an ExceededCapacityError)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const error = new Cause.ExceededCapacityError("Queue full")
 * console.log(error.message) // "Queue full"
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const ExceededCapacityError: new(message?: string) => ExceededCapacityError = effect.ExceededCapacityError

/**
 * Unique brand for {@link AsyncFiberError}.
 *
 * @since 4.0.0
 * @category symbols
 */
export const AsyncFiberErrorTypeId: "~effect/Cause/AsyncFiberError" = effect.AsyncFiberErrorTypeId

/**
 * @category guards
 * @since 4.0.0
 */
export const isAsyncFiberError: (u: unknown) => u is AsyncFiberError = effect.isAsyncFiberError

/**
 * An error that occurs when trying to run an async fiber with Effect.runSync.
 *
 * @since 4.0.0
 * @category errors
 */
export interface AsyncFiberError extends YieldableError {
  readonly [AsyncFiberErrorTypeId]: typeof AsyncFiberErrorTypeId
  readonly _tag: "AsyncFiberError"
  readonly fiber: Fiber<unknown, unknown>
}

/**
 * An error that occurs when trying to run an async fiber with Effect.runSync.
 *
 * @category constructors
 * @since 4.0.0
 */
export const AsyncFiberError: new(fiber: Fiber<unknown, unknown>) => AsyncFiberError = effect.AsyncFiberError

/**
 * Unique brand for {@link UnknownError}.
 *
 * @since 4.0.0
 * @category symbols
 */
export const UnknownErrorTypeId: "~effect/Cause/UnknownError" = effect.UnknownErrorTypeId

/**
 * Tests if an arbitrary value is an {@link UnknownError}.
 *
 * **Example** (runtime type check)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * console.log(Cause.isUnknownError(new Cause.UnknownError("x"))) // true
 * console.log(Cause.isUnknownError("nope")) // false
 * ```
 *
 * @category guards
 * @since 4.0.0
 */
export const isUnknownError: (u: unknown) => u is UnknownError = effect.isUnknownError

/**
 * A wrapper for errors whose type is not statically known.
 *
 * Produced by the runtime when an effect throws a non-`Error` value.
 * The original thrown value is stored in the `cause` property (inherited
 * from `Error`). Implements {@link YieldableError}.
 *
 * **Example** (creating and checking)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const error = new Cause.UnknownError("original", "Something unknown")
 * console.log(error._tag)    // "UnknownError"
 * console.log(error.message) // "Something unknown"
 * ```
 *
 * @see {@link isUnknownError} — type guard
 *
 * @since 4.0.0
 * @category errors
 */
export interface UnknownError extends YieldableError {
  readonly [UnknownErrorTypeId]: typeof UnknownErrorTypeId
  readonly _tag: "UnknownError"
}

/**
 * Constructs an {@link UnknownError}. The first argument is the original
 * cause (stored in `Error.cause`); the second is an optional human-readable
 * message.
 *
 * **Example** (creating an UnknownError)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const error = new Cause.UnknownError({ raw: true }, "Unexpected value")
 * console.log(error.message) // "Unexpected value"
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const UnknownError: new(cause: unknown, message?: string) => UnknownError = effect.UnknownError

/**
 * Attaches metadata to every reason in a {@link Cause}.
 *
 * Annotations are stored as a `ServiceMap` on each reason and can be
 * retrieved later via {@link reasonAnnotations} or {@link annotations}.
 * The runtime uses this to attach stack traces and spans.
 *
 * - Returns a new `Cause`; does not mutate the input.
 * - By default, existing keys are preserved. Pass `{ overwrite: true }` to
 *   replace them.
 *
 * **Example** (annotating a cause)
 *
 * ```ts
 * import { Cause, ServiceMap } from "effect"
 *
 * const cause = Cause.fail("error")
 * const annotated = Cause.annotate(cause, ServiceMap.empty())
 * ```
 *
 * @see {@link annotations} — read merged annotations from a cause
 * @see {@link reasonAnnotations} — read annotations from a single reason
 *
 * @category annotations
 * @since 4.0.0
 */
export const annotate: {
  (
    annotations: ServiceMap.ServiceMap<never>,
    options?: { readonly overwrite?: boolean | undefined }
  ): <E>(self: Cause<E>) => Cause<E>
  <E>(
    self: Cause<E>,
    annotations: ServiceMap.ServiceMap<never>,
    options?: { readonly overwrite?: boolean | undefined }
  ): Cause<E>
} = core.causeAnnotate

/**
 * Reads the annotations from a single {@link Reason} as a `ServiceMap`.
 *
 * Use this when you need tracing metadata (e.g. {@link StackTrace}) from
 * a specific reason rather than the whole cause.
 *
 * @see {@link annotations} — merged annotations from all reasons in a cause
 * @see {@link annotate} — attach annotations
 *
 * @category annotations
 * @since 4.0.0
 */
export const reasonAnnotations: <E>(self: Reason<E>) => ServiceMap.ServiceMap<never> = effect.reasonAnnotations

/**
 * Reads the merged annotations from all reasons in a {@link Cause}.
 *
 * Annotations from later reasons overwrite earlier ones when keys collide.
 *
 * @see {@link reasonAnnotations} — annotations from a single reason
 * @see {@link annotate} — attach annotations
 *
 * @category annotations
 * @since 4.0.0
 */
export const annotations: <E>(self: Cause<E>) => ServiceMap.ServiceMap<never> = effect.causeAnnotations

/**
 * `ServiceMap` key for the stack frame captured at the point of failure.
 *
 * The runtime annotates every reason with this when a stack frame is
 * available. Retrieve it via
 * `ServiceMap.get(Cause.reasonAnnotations(reason), Cause.StackTrace)`.
 *
 * @category annotations
 * @since 4.0.0
 */
export class StackTrace extends ServiceMap.Service<StackTrace, StackFrame>()("effect/Cause/StackTrace") {}

/**
 * `ServiceMap` key for the stack frame captured at the point of
 * interruption.
 *
 * Similar to {@link StackTrace} but specific to {@link Interrupt} reasons.
 *
 * @category annotations
 * @since 4.0.0
 */
export class InterruptorStackTrace
  extends ServiceMap.Service<InterruptorStackTrace, StackFrame>()("effect/Cause/InterruptorStackTrace")
{}
