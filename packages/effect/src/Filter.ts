/**
 * @since 4.0.0
 */
import type { Effect } from "./Effect.ts"
import * as Equal from "./Equal.ts"
import { dual } from "./Function.ts"
import * as Option from "./Option.ts"
import * as Predicate from "./Predicate.ts"
import * as Result from "./Result.ts"
import type { EqualsWith, ExcludeTag, ExtractReason, ExtractTag, ReasonTags, Tags } from "./Types.ts"

/**
 * Represents a filter function that can transform inputs to outputs or filter them out.
 *
 * A filter takes an input value and either returns a boxed pass value or
 * the special `fail` type to indicate the value should be filtered out.
 *
 * @example
 * ```ts
 * import { Filter, Result } from "effect"
 *
 * // A filter that only passes positive numbers
 * const positiveFilter: Filter.Filter<number> = (n) => n > 0 ? Result.succeed(n) : Result.fail(n)
 *
 * console.log(positiveFilter(5)) // Result.succeed(5)
 * console.log(positiveFilter(-3)) // Result.fail(-3)
 * ```
 *
 * @since 4.0.0
 * @category Models
 */
export interface Filter<in Input, out Pass = Input, out Fail = Input> {
  (input: Input): Result.Result<Pass, Fail>
}

/**
 * Represents an effectful filter function that can produce Effects.
 *
 * Similar to a regular Filter, but the filtering operation itself can be effectful,
 * allowing for asynchronous operations, error handling, and dependency injection.
 *
 * @example
 * ```ts
 * import { Effect, Filter, Result } from "effect"
 *
 * // An effectful filter that validates user data
 * type User = { id: string; isActive: boolean }
 * type ValidationError = { message: string }
 *
 * const validateUser: Filter.FilterEffect<
 *   string,
 *   User,
 *   User,
 *   ValidationError,
 *   never
 * > = (id) =>
 *   Effect.gen(function*() {
 *     const user: User = { id, isActive: id.length > 0 }
 *     return user.isActive ? Result.succeed(user) : Result.fail(user)
 *   })
 * ```
 *
 * @since 4.0.0
 * @category Models
 */
export interface FilterEffect<
  in Input,
  out Pass,
  out Fail,
  out E = never,
  out R = never
> {
  (input: Input): Effect<Result.Result<Pass, Fail>, E, R>
}

// -------------------------------------------------------------------------------------
// Constructors
// -------------------------------------------------------------------------------------

/**
 * Creates a Filter from a function that returns either a `pass` or `fail` value.
 *
 * This is the primary constructor for creating custom filters. The function
 * should return either `Result.succeed(value)` or `Result.fail(value)`.
 *
 * @example
 * ```ts
 * import { Filter, Result } from "effect"
 *
 * // Create a filter for positive numbers
 * const positiveFilter = Filter.make((n: number) => n > 0 ? Result.succeed(n) : Result.fail(n))
 *
 * // Create a filter that transforms strings to uppercase
 * const uppercaseFilter = Filter.make((s: string) =>
 *   s.length > 0 ? Result.succeed(s.toUpperCase()) : Result.fail(s)
 * )
 * ```
 *
 * @since 4.0.0
 * @category Constructors
 */
export const make = <Input, Pass, Fail>(
  f: (input: Input) => Result.Result<Pass, Fail>
): Filter<Input, Pass, Fail> => f as any

/**
 * Creates an effectful Filter from a function that returns an Effect.
 *
 * This constructor is used when the filtering operation needs to perform
 * effectful computations, such as async operations, error handling, or
 * accessing services from the environment.
 *
 * @example
 * ```ts
 * import { Effect, Filter, Result } from "effect"
 *
 * // Create an effectful filter that validates async
 * const asyncValidate = Filter.makeEffect((id: string) =>
 *   Effect.gen(function*() {
 *     const isValid = yield* Effect.succeed(id.length > 0)
 *     return isValid ? Result.succeed(id) : Result.fail(id)
 *   })
 * )
 * ```
 *
 * @since 4.0.0
 * @category Constructors
 */
export const makeEffect = <Input, Pass, Fail, E, R>(
  f: (input: Input) => Effect<Result.Result<Pass, Fail>, E, R>
): FilterEffect<Input, Pass, Fail, E, R> => f as any

/**
 * @since 4.0.0
 * @category Mapping
 */
export const mapFail: {
  <Fail, Fail2>(f: (fail: Fail) => Fail2): <Input, Pass>(self: Filter<Input, Pass, Fail>) => Filter<Input, Pass, Fail2>
  <Input, Pass, Fail, Fail2>(
    self: Filter<Input, Pass, Fail>,
    f: (fail: Fail) => Fail2
  ): Filter<Input, Pass, Fail2>
} = dual(2, <Input, Pass, Fail, Fail2>(
  self: Filter<Input, Pass, Fail>,
  f: (value: Fail) => Fail2
): Filter<Input, Pass, Fail2> =>
(input: Input): Result.Result<Pass, Fail2> => Result.mapError(self(input), f))

const try_ = <Input, Output>(f: (input: Input) => Output): Filter<Input, Output> => (input) => {
  try {
    return Result.succeed(f(input))
  } catch {
    return Result.fail(input)
  }
}

export {
  /**
   * Creates a Filter that tries to apply a function and returns `fail` on
   * error.
   *
   * @since 4.0.0
   * @category Constructors
   */
  try_ as try
}

/**
 * Creates a Filter from a predicate or refinement function.
 *
 * This is a convenient way to create filters from boolean-returning functions.
 * When the predicate returns true, the input value is passed through unchanged.
 * When it returns false, the `fail` type is returned.
 *
 * @example
 * ```ts
 * import { Filter, Result } from "effect"
 *
 * // Create filter from predicate
 * const positiveNumbers = Filter.fromPredicate((n: number) => n > 0)
 * const nonEmptyStrings = Filter.fromPredicate((s: string) => s.length > 0)
 *
 * // Type refinement
 * const isString = Filter.fromPredicate((x: unknown): x is string =>
 *   typeof x === "string"
 * )
 * ```
 *
 * @since 4.0.0
 * @category Constructors
 */
export const fromPredicate: {
  <A, B extends A>(refinement: Predicate.Refinement<A, B>): Filter<A, B, EqualsWith<A, B, A, Exclude<A, B>>>
  <A>(predicate: Predicate.Predicate<A>): Filter<A>
} = <A, B extends A = A>(predicate: Predicate.Predicate<A> | Predicate.Refinement<A, B>): Filter<A, B> => (input: A) =>
  predicate(input) ? Result.succeed(input as B) : Result.fail(input)

/**
 * Creates a Filter from a function that returns an Option.
 *
 * @since 4.0.0
 * @category Constructors
 */
export const fromPredicateOption = <A, B>(predicate: (a: A) => Option.Option<B>): Filter<A, B> => (input) => {
  const o = predicate(input)
  return o._tag === "None" ? Result.fail(input) : Result.succeed(o.value)
}

/**
 * Converts a Filter into a predicate function.
 *
 * @since 4.0.0
 * @category Constructors
 */
export const toPredicate = <A, Pass, Fail>(
  self: Filter<A, Pass, Fail>
): Predicate.Predicate<A> =>
(input: A) => !Result.isFailure(self(input))

/**
 * A predefined filter that only passes through string values.
 *
 * @example
 * ```ts
 * import { Filter, Result } from "effect"
 *
 * console.log(Filter.string("hello")) // Result.succeed("hello")
 * console.log(Filter.string(42)) // fail
 * ```
 *
 * @since 4.0.0
 * @category Constructors
 */
export const string: Filter<unknown, string> = fromPredicate(Predicate.isString)

/**
 * @since 4.0.0
 * @category Constructors
 */
export const equalsStrict =
  <const A, Input = unknown>(value: A): Filter<Input, A, EqualsWith<Input, A, A, Exclude<Input, A>>> => (u) =>
    (u as unknown) === value ? Result.succeed(value) : Result.fail(u as any)

/**
 * @since 4.0.0
 * @category Constructors
 */
export const has =
  <K>(key: K) => <Input extends { readonly has: (key: K) => boolean }>(input: Input): Result.Result<Input, Input> =>
    input.has(key) ? Result.succeed(input) : Result.fail(input)

/**
 * Creates a filter that only passes instances of the given constructor.
 *
 * @since 4.0.0
 * @category Constructors
 */
export const instanceOf =
  <K extends new(...args: any) => any>(constructor: K) =>
  <Input>(u: Input): Result.Result<InstanceType<K>, Exclude<Input, InstanceType<K>>> =>
    u instanceof constructor ? Result.succeed(u as InstanceType<K>) : Result.fail(u) as any

/**
 * A predefined filter that only passes through number values.
 *
 * @example
 * ```ts
 * import { Filter, Result } from "effect"
 *
 * console.log(Filter.number(42)) // Result.succeed(42)
 * console.log(Filter.number("42")) // fail
 * ```
 *
 * @since 4.0.0
 * @category Constructors
 */
export const number: Filter<unknown, number> = fromPredicate(Predicate.isNumber)

/**
 * A predefined filter that only passes through boolean values.
 *
 * @since 4.0.0
 * @category Constructors
 */
export const boolean: Filter<unknown, boolean> = fromPredicate(Predicate.isBoolean)

/**
 * A predefined filter that only passes through BigInt values.
 *
 * @since 4.0.0
 * @category Constructors
 */
export const bigint: Filter<unknown, bigint> = fromPredicate(Predicate.isBigInt)

/**
 * A predefined filter that only passes through Symbol values.
 *
 * @since 4.0.0
 * @category Constructors
 */
export const symbol: Filter<unknown, symbol> = fromPredicate(Predicate.isSymbol)

/**
 * A predefined filter that only passes through Date objects.
 *
 * @since 4.0.0
 * @category Constructors
 */
export const date: Filter<unknown, Date> = fromPredicate(Predicate.isDate)

/**
 * Creates a filter that checks if an input is tagged with a specific tag.
 *
 * @since 4.0.0
 * @category Constructors
 */
export const tagged: {
  <Input>(): <const Tag extends Tags<Input>>(tag: Tag) => Filter<Input, ExtractTag<Input, Tag>, ExcludeTag<Input, Tag>>
  <Input, const Tag extends Tags<Input>>(
    tag: Tag
  ): Filter<Input, ExtractTag<Input, Tag>, ExcludeTag<Input, Tag>>
  <const Tag extends string>(
    tag: Tag
  ): <Input>(input: Input) => Result.Result<ExtractTag<Input, Tag>, ExcludeTag<Input, Tag>>
} = function() {
  return arguments.length === 0 ? taggedImpl : taggedImpl(arguments[0] as any)
} as any

const taggedImpl =
  <const Tag extends string>(tag: Tag) =>
  <Input>(input: Input): Result.Result<ExtractTag<Input, Tag>, ExcludeTag<Input, Tag>> =>
    Predicate.isTagged(input, tag) ? Result.succeed(input as any) : Result.fail(input as ExcludeTag<Input, Tag>)

/**
 * Creates a filter that extracts a reason from a tagged error.
 *
 * @since 4.0.0
 * @category Constructors
 */
export const reason: {
  <Input>(): <const Tag extends Tags<Input>, const ReasonTag extends ReasonTags<ExtractTag<Input, Tag>>>(
    tag: Tag,
    reasonTag: ReasonTag
  ) => Filter<Input, ExtractReason<ExtractTag<Input, Tag>, ReasonTag>, Input>
  <Input, const Tag extends Tags<Input>, const ReasonTag extends ReasonTags<ExtractTag<Input, Tag>>>(
    tag: Tag,
    reasonTag: ReasonTag
  ): Filter<Input, ExtractReason<ExtractTag<Input, Tag>, ReasonTag>, Input>
  <const Tag extends string, const ReasonTag extends string>(
    tag: Tag,
    reasonTag: ReasonTag
  ): <Input>(input: Input) => Result.Result<ExtractReason<ExtractTag<Input, Tag>, ReasonTag>, Input>
} = function() {
  return arguments.length === 0 ? reasonImpl : reasonImpl(arguments[0] as any, arguments[1] as any)
} as any

const reasonImpl =
  <const Tag extends string, const ReasonTag extends string>(tag: Tag, reasonTag: ReasonTag) =>
  <Input>(input: Input): Result.Result<ExtractTag<Input, Tag>, ExcludeTag<Input, Tag>> => {
    if (
      Predicate.isTagged(input, tag) && Predicate.hasProperty(input, "reason") &&
      Predicate.isTagged(input.reason, reasonTag)
    ) {
      return Result.succeed(input.reason as any)
    }
    return Result.fail(input as any)
  }

/**
 * Creates a filter that only passes values equal to the specified value using structural equality.
 *
 * @since 4.0.0
 * @category Constructors
 */
export const equals =
  <const A, Input = unknown>(value: A): Filter<Input, A, EqualsWith<Input, A, A, Exclude<Input, A>>> => (u) =>
    Equal.equals(u, value) ? Result.succeed(value) : Result.fail(u as any)

/**
 * Combines two filters with logical OR semantics.
 *
 * @since 4.0.0
 * @category Combinators
 */
export const or: {
  <Input2, Pass2, Fail2>(
    that: Filter<Input2, Pass2, Fail2>
  ): <Input1, Pass2, Fail2>(self: Filter<Input1, Pass2>) => Filter<Input1 & Input2, Pass2 | Pass2, Fail2>
  <Input1, Pass1, Fail1, Input2, Pass2, Fail2>(
    self: Filter<Input1, Pass1, Fail1>,
    that: Filter<Input2, Pass2, Fail2>
  ): Filter<Input1 & Input2, Pass1 | Pass2, Fail2>
} = dual(2, <Input1, Pass1, Fail1, Input2, Pass2, Fail2>(
  self: Filter<Input1, Pass1, Fail1>,
  that: Filter<Input2, Pass2, Fail2>
): Filter<Input1 & Input2, Pass1 | Pass2, Fail2> =>
(input) => {
  const selfResult = self(input)
  return Result.isSuccess(selfResult) ? selfResult as Result.Result<Pass1> : that(input)
})

/**
 * Combines two filters and applies a function to their results.
 *
 * Both filters must succeed (not return `fail`) for the combination to succeed.
 * If both filters pass, their outputs are combined using the provided function.
 *
 * @since 4.0.0
 * @category Combinators
 */
export const zipWith: {
  <PassL, InputR, PassR, FailR, A>(
    right: Filter<InputR, PassR, FailR>,
    f: (left: PassL, right: PassR) => A
  ): <InputL, FailL>(left: Filter<InputL, PassL, FailL>) => Filter<InputL & InputR, A, FailL | FailR>
  <InputL, PassL, FailL, InputR, PassR, FailR, A>(
    left: Filter<InputL, PassL, FailL>,
    right: Filter<InputR, PassR, FailR>,
    f: (left: PassL, right: PassR) => A
  ): Filter<InputL & InputR, A, FailL | FailR>
} = dual(3, <InputL, PassL, FailL, InputR, PassR, FailR, A>(
  left: Filter<InputL, PassL, FailL>,
  right: Filter<InputR, PassR, FailR>,
  f: (left: PassL, right: PassR) => A
): Filter<InputL & InputR, A, FailL | FailR> =>
(input) => {
  const leftResult = left(input)
  if (Result.isFailure(leftResult)) return leftResult as Result.Result<never, FailL | FailR>
  const rightResult = right(input)
  if (Result.isFailure(rightResult)) return rightResult as Result.Result<never, FailL | FailR>
  return Result.succeed(f(leftResult.success, rightResult.success))
})

/**
 * Combines two filters into a tuple of their results.
 *
 * Both filters must succeed for the combination to succeed. If both pass,
 * their outputs are combined into a tuple.
 *
 * @example
 * ```ts
 * import { Filter } from "effect"
 *
 * const positiveNumbers = Filter.fromPredicate((n: number) => n > 0)
 * const evenNumbers = Filter.fromPredicate((n: number) => n % 2 === 0)
 *
 * const positiveAndEven = Filter.zip(positiveNumbers, evenNumbers)
 * ```
 *
 * @since 4.0.0
 * @category Combinators
 */
export const zip: {
  <InputR, PassR, FailR>(
    right: Filter<InputR, PassR, FailR>
  ): <InputL, PassL, FailL>(
    left: Filter<InputL, PassL, FailL>
  ) => Filter<InputL & InputR, [PassL, PassR], FailL | FailR>
  <InputL, PassL, FailL, InputR, PassR, FailR>(
    left: Filter<InputL, PassL, FailL>,
    right: Filter<InputR, PassR, FailR>
  ): Filter<InputL & InputR, [PassL, PassR], FailL | FailR>
} = dual(2, <InputL, PassL, FailL, InputR, PassR, FailR>(
  left: Filter<InputL, PassL, FailL>,
  right: Filter<InputR, PassR, FailR>
): Filter<InputL & InputR, [PassL, PassR], FailL | FailR> =>
  zipWith(left, right, (leftResult, rightResult) => [leftResult, rightResult]))

/**
 * Combines two filters but only returns the result of the left filter.
 *
 * @example
 * ```ts
 * import { Filter } from "effect"
 *
 * const positiveNumbers = Filter.fromPredicate((n: number) => n > 0)
 * const evenNumbers = Filter.fromPredicate((n: number) => n % 2 === 0)
 *
 * const positiveEven = Filter.andLeft(positiveNumbers, evenNumbers)
 * ```
 *
 * @since 4.0.0
 * @category Combinators
 */
export const andLeft: {
  <InputR, PassR, FailR>(
    right: Filter<InputR, PassR, FailR>
  ): <InputL, PassL, FailL>(
    left: Filter<InputL, PassL, FailL>
  ) => Filter<InputL & InputR, PassL, FailL | FailR>
  <InputL, PassL, FailL, InputR, PassR, FailR>(
    left: Filter<InputL, PassL, FailL>,
    right: Filter<InputR, PassR, FailR>
  ): Filter<InputL & InputR, PassL, FailL | FailR>
} = dual(2, <InputL, PassL, FailL, InputR, PassR, FailR>(
  left: Filter<InputL, PassL, FailL>,
  right: Filter<InputR, PassR, FailR>
): Filter<InputL & InputR, PassL, FailL | FailR> => zipWith(left, right, (leftResult) => leftResult))

/**
 * Combines two filters but only returns the result of the right filter.
 *
 * @example
 * ```ts
 * import { Filter, Result } from "effect"
 *
 * const positiveNumbers = Filter.fromPredicate((n: number) => n > 0)
 * const doubleNumbers = Filter.make((n: number) =>
 *   n > 0 ? Result.succeed(n * 2) : Result.fail(n)
 * )
 *
 * const positiveDoubled = Filter.andRight(positiveNumbers, doubleNumbers)
 * ```
 *
 * @since 4.0.0
 * @category Combinators
 */
export const andRight: {
  <InputR, PassR, FailR>(
    right: Filter<InputR, PassR, FailR>
  ): <InputL, PassL, FailL>(
    left: Filter<InputL, PassL, FailL>
  ) => Filter<InputL & InputR, PassR, FailL | FailR>
  <InputL, PassL, FailL, InputR, PassR, FailR>(
    left: Filter<InputL, PassL, FailL>,
    right: Filter<InputR, PassR, FailR>
  ): Filter<InputL & InputR, PassR, FailL | FailR>
} = dual(2, <InputL, PassL, FailL, InputR, PassR, FailR>(
  left: Filter<InputL, PassL, FailL>,
  right: Filter<InputR, PassR, FailR>
): Filter<InputL & InputR, PassR, FailL | FailR> => zipWith(left, right, (_, rightResult) => rightResult))

/**
 * Composes two filters sequentially, feeding the output of the first into the second.
 *
 * @example
 * ```ts
 * import { Filter, Result } from "effect"
 *
 * const stringFilter = Filter.string
 * const nonEmptyUpper = Filter.make((s: string) =>
 *   s.length > 0 ? Result.succeed(s.toUpperCase()) : Result.fail(s)
 * )
 *
 * const stringToUpper = Filter.compose(stringFilter, nonEmptyUpper)
 * ```
 *
 * @since 4.0.0
 * @category Combinators
 */
export const compose: {
  <PassL, PassR, FailR>(
    right: Filter<PassL, PassR, FailR>
  ): <InputL, FailL>(left: Filter<InputL, PassL, FailL>) => Filter<InputL, PassR, FailL | FailR>
  <InputL, PassL, FailL, PassR, FailR>(
    left: Filter<InputL, PassL, FailL>,
    right: Filter<PassL, PassR, FailR>
  ): Filter<InputL, PassR, FailL | FailR>
} = dual(2, <InputL, PassL, FailL, PassR, FailR>(
  left: Filter<InputL, PassL, FailL>,
  right: Filter<PassL, PassR, FailR>
): Filter<InputL, PassR, FailL | FailR> =>
(input) => {
  const leftOut = left(input)
  if (Result.isFailure(leftOut)) return leftOut as Result.Result<never, FailL | FailR>
  return right(leftOut.success)
})

/**
 * Composes two filters sequentially, allowing the output of the first to be
 * passed to the second.
 *
 * This is similar to `compose`, but it will always fail with the original
 * input.
 *
 * @since 4.0.0
 * @category Combinators
 */
export const composePassthrough: {
  <InputL, PassL, PassR, FailR>(
    right: Filter<PassL, PassR, FailR>
  ): <FailL>(left: Filter<InputL, PassL, FailL>) => Filter<InputL, PassR, InputL>
  <InputL, PassL, FailL, PassR, FailR>(
    left: Filter<InputL, PassL, FailL>,
    right: Filter<PassL, PassR, FailR>
  ): Filter<InputL, PassR, InputL>
} = dual(2, <InputL, PassL, FailL, PassR, FailR>(
  left: Filter<InputL, PassL, FailL>,
  right: Filter<PassL, PassR, FailR>
): Filter<InputL, PassR, InputL> =>
(input) => {
  const leftOut = left(input)
  if (Result.isFailure(leftOut)) return Result.fail(input)
  const rightOut = right(leftOut.success)
  if (Result.isFailure(rightOut)) return Result.fail(input)
  return rightOut as Result.Result<PassR>
})

/**
 * @since 4.0.0
 * @category Conversions
 */
export const toOption = <A, Pass, Fail>(
  self: Filter<A, Pass, Fail>
): (input: A) => Option.Option<Pass> =>
(input: A) => {
  const result = self(input)
  return Result.isFailure(result) ? Option.none() : Option.some(result.success)
}

/**
 * @since 4.0.0
 * @category Conversions
 */
export const toResult = <A, Pass, Fail>(
  self: Filter<A, Pass, Fail>
): (input: A) => Result.Result<Pass, Fail> =>
(input: A) => {
  const result = self(input)
  return Result.isFailure(result) ? Result.fail(result.failure) : Result.succeed(result.success)
}
