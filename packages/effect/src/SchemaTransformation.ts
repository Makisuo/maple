/**
 * Bidirectional transformations for the Effect Schema system.
 *
 * A `Transformation` pairs a decode `Getter` and an encode `Getter` into a
 * single bidirectional value, used by `Schema.decodeTo`, `Schema.encodeTo`,
 * `Schema.decode`, `Schema.encode`, and `Schema.link` to define how values
 * are converted between encoded and decoded representations. A `Middleware`
 * is the effect-level equivalent — it wraps the entire parsing `Effect`
 * pipeline rather than individual values.
 *
 * ## Mental model
 *
 * - **Transformation**: A pair of `Getter`s (decode + encode) that convert
 *   individual values bidirectionally. `T` is the decoded (Type) side, `E` is
 *   the encoded side. `RD`/`RE` are required Effect services.
 * - **Middleware**: Like `Transformation`, but each direction receives the full
 *   parsing `Effect` and can intercept, retry, or modify the pipeline.
 * - **Getter**: A single-direction transform `Option<E> → Effect<Option<T>, Issue, R>`
 *   (see `SchemaGetter`).
 * - **flip()**: Swaps decode and encode, turning a `Transformation<T, E>` into
 *   `Transformation<E, T>`.
 * - **compose()**: Chains two transformations left-to-right on the decode side
 *   and right-to-left on the encode side.
 * - **passthrough**: The identity transformation — no conversion in either
 *   direction.
 *
 * ## Common tasks
 *
 * - Convert values purely (sync, infallible) → {@link transform}
 * - Convert values with possible failure → {@link transformOrFail}
 * - Handle optional/missing keys → {@link transformOptional}
 * - Build from existing Getters → {@link make}
 * - No-op identity transformation → {@link passthrough}
 * - Subtype/supertype coercion → {@link passthroughSupertype}, {@link passthroughSubtype}
 * - Trim/case strings → {@link trim}, {@link toLowerCase}, {@link toUpperCase}, {@link capitalize}, {@link uncapitalize}, {@link snakeToCamel}
 * - Parse key-value strings → {@link splitKeyValue}
 * - Coerce string ↔ number/bigint → {@link numberFromString}, {@link bigintFromString}
 * - Decode durations → {@link durationFromNanos}, {@link durationFromMillis}
 * - Wrap nullable/optional as Option → {@link optionFromNullOr}, {@link optionFromOptionalKey}, {@link optionFromOptional}
 * - Parse URLs → {@link urlFromString}
 * - Base64 ↔ Uint8Array → {@link uint8ArrayFromBase64String}
 * - JSON string ↔ unknown → {@link fromJsonString}
 * - FormData/URLSearchParams ↔ unknown → {@link fromFormData}, {@link fromURLSearchParams}
 * - Check if a value is a Transformation → {@link isTransformation}
 *
 * ## Gotchas
 *
 * - `Transformation` operates on individual values; `Middleware` wraps the
 *   entire parsing Effect. Choose accordingly.
 * - `passthrough` requires `T === E` by default. Use `{ strict: false }` to
 *   bypass, or use {@link passthroughSupertype} / {@link passthroughSubtype}.
 * - String transformations like `trim`, `toLowerCase`, and `toUpperCase` use
 *   `passthrough` on the encode side — they are lossy and do not round-trip.
 * - `durationFromNanos` encode can fail if the Duration cannot be represented
 *   as a `bigint`.
 *
 * ## Quickstart
 *
 * **Example** (Defining a custom transformation with Schema.decodeTo)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const CentsFromDollars = Schema.Number.pipe(
 *   Schema.decodeTo(
 *     Schema.Number,
 *     SchemaTransformation.transform({
 *       decode: (dollars) => dollars * 100,
 *       encode: (cents) => cents / 100
 *     })
 *   )
 * )
 * ```
 *
 * ## See also
 *
 * - {@link Transformation} — the core bidirectional transformation class
 * - {@link Middleware} — effect-pipeline-level transformation
 * - {@link transform} — most common constructor
 * - {@link passthrough} — identity transformation
 *
 * @since 4.0.0
 */

import * as BigDecimal from "./BigDecimal.ts"
import * as DateTime from "./DateTime.ts"
import * as Duration from "./Duration.ts"
import * as Effect from "./Effect.ts"
import * as Option from "./Option.ts"
import * as Predicate from "./Predicate.ts"
import type * as AST from "./SchemaAST.ts"
import * as Getter from "./SchemaGetter.ts"
import * as Issue from "./SchemaIssue.ts"

/**
 * A middleware that wraps the entire parsing `Effect` pipeline for both
 * decode and encode directions.
 *
 * Unlike `Transformation`, which operates on individual values via `Getter`,
 * `Middleware` receives the full `Effect` produced by the inner schema and can
 * intercept, modify, retry, or replace it.
 *
 * When to use this:
 * - You need to catch or recover from parsing errors (e.g. `Schema.catchDecoding`).
 * - You need to run side effects around the parsing pipeline.
 * - You need access to the full `Effect` rather than a single decoded value.
 *
 * Behavior:
 * - Immutable — constructing a Middleware does not mutate existing instances.
 * - `decode` receives an `Effect<Option<E>, Issue, RDE>` and returns
 *   `Effect<Option<T>, Issue, RDT>`.
 * - `encode` receives an `Effect<Option<T>, Issue, RET>` and returns
 *   `Effect<Option<E>, Issue, REE>`.
 * - `flip()` swaps the decode and encode functions, producing a
 *   `Middleware<E, T, ...>`.
 *
 * Typically constructed indirectly via `Schema.middlewareDecoding` or
 * `Schema.middlewareEncoding` rather than instantiating this class directly.
 *
 * **Example** (Creating a middleware that falls back on decode failure)
 *
 * ```ts
 * import { Effect, Option, SchemaTransformation } from "effect"
 *
 * const fallback = new SchemaTransformation.Middleware(
 *   (effect) => Effect.catch(effect, () => Effect.succeed(Option.some("fallback"))),
 *   (effect) => effect
 * )
 * ```
 *
 * See also:
 * - {@link Transformation} — value-level bidirectional transformation
 *
 * @category model
 * @since 4.0.0
 */
export class Middleware<in out T, in out E, RDE, RDT, RET, REE> {
  readonly _tag = "Middleware"
  readonly decode: (
    effect: Effect.Effect<Option.Option<E>, Issue.Issue, RDE>,
    options: AST.ParseOptions
  ) => Effect.Effect<Option.Option<T>, Issue.Issue, RDT>
  readonly encode: (
    effect: Effect.Effect<Option.Option<T>, Issue.Issue, RET>,
    options: AST.ParseOptions
  ) => Effect.Effect<Option.Option<E>, Issue.Issue, REE>

  constructor(
    decode: (
      effect: Effect.Effect<Option.Option<E>, Issue.Issue, RDE>,
      options: AST.ParseOptions
    ) => Effect.Effect<Option.Option<T>, Issue.Issue, RDT>,
    encode: (
      effect: Effect.Effect<Option.Option<T>, Issue.Issue, RET>,
      options: AST.ParseOptions
    ) => Effect.Effect<Option.Option<E>, Issue.Issue, REE>
  ) {
    this.decode = decode
    this.encode = encode
  }
  flip(): Middleware<E, T, RET, REE, RDE, RDT> {
    return new Middleware(this.encode, this.decode)
  }
}

const TypeId = "~effect/SchemaTransformation/Transformation"

/**
 * A bidirectional transformation between a decoded type `T` and an encoded
 * type `E`, built from a pair of `Getter`s.
 *
 * This is the primary building block for `Schema.decodeTo`, `Schema.encodeTo`,
 * `Schema.decode`, `Schema.encode`, and `Schema.link`. Each direction is a
 * `SchemaGetter.Getter` that handles optionality, failure, and Effect services.
 *
 * When to use this:
 * - You need to define how a schema converts between two representations.
 * - You want to compose multiple transformations into a pipeline.
 * - You want to flip a transformation to swap decode/encode.
 *
 * Behavior:
 * - Immutable — `flip()` and `compose()` return new instances.
 * - `flip()` swaps the decode and encode getters.
 * - `compose(other)` chains: `this.decode` then `other.decode` for decoding,
 *   `other.encode` then `this.encode` for encoding.
 *
 * **Example** (Composing two transformations)
 *
 * ```ts
 * import { SchemaTransformation } from "effect"
 *
 * const trimAndLower = SchemaTransformation.trim().compose(
 *   SchemaTransformation.toLowerCase()
 * )
 * // decode: trim then lowercase
 * // encode: passthrough (both directions)
 * ```
 *
 * See also:
 * - {@link make} — construct from `{ decode, encode }` getters
 * - {@link transform} — construct from pure functions
 * - {@link transformOrFail} — construct from effectful functions
 * - {@link Middleware} — effect-pipeline-level alternative
 *
 * @category model
 * @since 4.0.0
 */
export class Transformation<in out T, in out E, RD = never, RE = never> {
  readonly [TypeId] = TypeId
  readonly _tag = "Transformation"
  readonly decode: Getter.Getter<T, E, RD>
  readonly encode: Getter.Getter<E, T, RE>

  constructor(
    decode: Getter.Getter<T, E, RD>,
    encode: Getter.Getter<E, T, RE>
  ) {
    this.decode = decode
    this.encode = encode
  }
  flip(): Transformation<E, T, RE, RD> {
    return new Transformation(this.encode, this.decode)
  }
  compose<T2, RD2, RE2>(other: Transformation<T2, T, RD2, RE2>): Transformation<T2, E, RD | RD2, RE | RE2> {
    return new Transformation(
      this.decode.compose(other.decode),
      other.encode.compose(this.encode)
    )
  }
}

/**
 * Returns `true` if `u` is a `Transformation` instance.
 *
 * When to use this:
 * - Checking whether a value is already a Transformation before wrapping it.
 *
 * Behavior:
 * - Pure predicate, no side effects.
 * - Acts as a TypeScript type guard.
 *
 * **Example** (Checking a value)
 *
 * ```ts
 * import { SchemaTransformation } from "effect"
 *
 * SchemaTransformation.isTransformation(SchemaTransformation.trim())
 * // true
 *
 * SchemaTransformation.isTransformation({ decode: null, encode: null })
 * // false
 * ```
 *
 * See also:
 * - {@link Transformation}
 * - {@link make}
 *
 * @since 4.0.0
 */
export function isTransformation(u: unknown): u is Transformation<any, any, unknown, unknown> {
  return Predicate.hasProperty(u, TypeId)
}

/**
 * Constructs a `Transformation` from an object with `decode` and `encode`
 * `Getter`s. If the input is already a `Transformation`, returns it as-is.
 *
 * When to use this:
 * - You already have `Getter` instances and want to pair them.
 * - You want idempotent wrapping (won't double-wrap).
 *
 * Behavior:
 * - Does not mutate the input.
 * - Returns the input unchanged if it is already a `Transformation`.
 *
 * **Example** (Wrapping existing getters)
 *
 * ```ts
 * import { SchemaGetter, SchemaTransformation } from "effect"
 *
 * const t = SchemaTransformation.make({
 *   decode: SchemaGetter.transform<number, string>((s) => Number(s)),
 *   encode: SchemaGetter.transform<string, number>((n) => String(n))
 * })
 * ```
 *
 * See also:
 * - {@link transform} — simpler constructor from pure functions
 * - {@link transformOrFail} — constructor from effectful functions
 * - {@link Transformation}
 *
 * @since 4.0.0
 */
export const make = <T, E, RD = never, RE = never>(options: {
  readonly decode: Getter.Getter<T, E, RD>
  readonly encode: Getter.Getter<E, T, RE>
}): Transformation<T, E, RD, RE> => {
  if (isTransformation(options)) {
    return options as any
  }
  return new Transformation(options.decode, options.encode)
}

/**
 * Creates a `Transformation` from effectful decode and encode functions that
 * can fail with `Issue`.
 *
 * When to use this:
 * - The transformation can fail (e.g. parsing, validation).
 * - The transformation requires Effect services.
 *
 * Behavior:
 * - Each function receives the input value and `ParseOptions`.
 * - Must return an `Effect` that succeeds with the output or fails with `Issue`.
 * - Skips `None` inputs (missing keys) — functions are only called on present values.
 *
 * **Example** (Parsing a date string that can fail)
 *
 * ```ts
 * import { Effect, Option, Schema, SchemaIssue, SchemaTransformation } from "effect"
 *
 * const DateFromString = Schema.String.pipe(
 *   Schema.decodeTo(
 *     Schema.Date,
 *     SchemaTransformation.transformOrFail({
 *       decode: (s) => {
 *         const d = new Date(s)
 *         return isNaN(d.getTime())
 *           ? Effect.fail(new SchemaIssue.InvalidValue(Option.some(s), { message: "Invalid date" }))
 *           : Effect.succeed(d)
 *       },
 *       encode: (d) => Effect.succeed(d.toISOString())
 *     })
 *   )
 * )
 * ```
 *
 * See also:
 * - {@link transform} — for infallible, pure transformations
 * - {@link transformOptional} — for transformations that handle missing keys
 * - {@link make} — for transformations from existing Getters
 *
 * @since 4.0.0
 */
export function transformOrFail<T, E, RD = never, RE = never>(options: {
  readonly decode: (e: E, options: AST.ParseOptions) => Effect.Effect<T, Issue.Issue, RD>
  readonly encode: (t: T, options: AST.ParseOptions) => Effect.Effect<E, Issue.Issue, RE>
}): Transformation<T, E, RD, RE> {
  return new Transformation(
    Getter.transformOrFail(options.decode),
    Getter.transformOrFail(options.encode)
  )
}

/**
 * Creates a `Transformation` from pure (sync, infallible) decode and encode
 * functions.
 *
 * When to use this:
 * - The conversion cannot fail.
 * - No Effect services are needed.
 *
 * Behavior:
 * - Each function receives the input and returns the output directly.
 * - Skips `None` inputs (missing keys) — functions are only called on present values.
 * - Does not allocate Effects internally; uses optimized sync path.
 *
 * **Example** (Converting between cents and dollars)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const CentsFromDollars = Schema.Number.pipe(
 *   Schema.decodeTo(
 *     Schema.Number,
 *     SchemaTransformation.transform({
 *       decode: (dollars) => dollars * 100,
 *       encode: (cents) => cents / 100
 *     })
 *   )
 * )
 * ```
 *
 * See also:
 * - {@link transformOrFail} — for fallible or effectful transformations
 * - {@link transformOptional} — for transformations that handle missing keys
 * - {@link passthrough} — when no conversion is needed
 *
 * @since 4.0.0
 */
export function transform<T, E>(options: {
  readonly decode: (input: E) => T
  readonly encode: (input: T) => E
}): Transformation<T, E> {
  return new Transformation(
    Getter.transform(options.decode),
    Getter.transform(options.encode)
  )
}

/**
 * Creates a `Transformation` where decode and encode operate on `Option`
 * values, giving full control over missing-key handling.
 *
 * When to use this:
 * - You need to produce or consume `Option.None` to represent absent keys.
 * - You are working with optional struct fields.
 *
 * Behavior:
 * - Each function receives `Option<input>` and returns `Option<output>`.
 * - `Option.None` input means the key is absent; returning `Option.None`
 *   omits the key from the output.
 * - Pure and synchronous.
 *
 * **Example** (Converting an optional key to Option)
 *
 * ```ts
 * import { Option, Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.Struct({
 *   a: Schema.optionalKey(Schema.Number).pipe(
 *     Schema.decodeTo(
 *       Schema.Option(Schema.Number),
 *       SchemaTransformation.transformOptional({
 *         decode: Option.some,
 *         encode: Option.flatten
 *       })
 *     )
 *   )
 * })
 * ```
 *
 * See also:
 * - {@link transform} — when you don't need Option-level control
 * - {@link optionFromOptionalKey} — built-in for the common optional-key-to-Option pattern
 * - {@link optionFromOptional} — built-in for optional (undefined) to Option
 *
 * @since 4.0.0
 */
export function transformOptional<T, E>(options: {
  readonly decode: (input: Option.Option<E>) => Option.Option<T>
  readonly encode: (input: Option.Option<T>) => Option.Option<E>
}): Transformation<T, E> {
  return new Transformation(
    Getter.transformOptional(options.decode),
    Getter.transformOptional(options.encode)
  )
}

/**
 * A string-to-string transformation that trims whitespace on decode.
 * Encode is passthrough (no change).
 *
 * When to use this:
 * - Normalizing user input by stripping leading/trailing whitespace.
 *
 * Behavior:
 * - Decode: applies `String.prototype.trim()`.
 * - Encode: passthrough (returns the string unchanged).
 * - Not round-trippable if the original had whitespace.
 *
 * **Example** (Trimming on decode)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const Trimmed = Schema.String.pipe(
 *   Schema.decode(SchemaTransformation.trim())
 * )
 * ```
 *
 * See also:
 * - {@link toLowerCase}
 * - {@link toUpperCase}
 * - {@link snakeToCamel}
 *
 * @category String transformations
 * @since 4.0.0
 */
export function trim(): Transformation<string, string> {
  return new Transformation(
    Getter.trim(),
    Getter.passthrough()
  )
}

/**
 * A string-to-string transformation that converts snake_case to camelCase
 * on decode and camelCase to snake_case on encode.
 *
 * When to use this:
 * - Converting API field names between snake_case and camelCase conventions.
 *
 * Behavior:
 * - Decode: `"my_field_name"` → `"myFieldName"`.
 * - Encode: `"myFieldName"` → `"my_field_name"`.
 * - Round-trippable for standard snake_case/camelCase.
 *
 * **Example** (Snake to camel conversion)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const SnakeToCamel = Schema.String.pipe(
 *   Schema.decode(SchemaTransformation.snakeToCamel())
 * )
 * ```
 *
 * See also:
 * - {@link trim}
 * - {@link toLowerCase}
 *
 * @category String transformations
 * @since 4.0.0
 */
export function snakeToCamel(): Transformation<string, string> {
  return new Transformation(
    Getter.snakeToCamel(),
    Getter.camelToSnake()
  )
}

/**
 * A string-to-string transformation that lowercases on decode.
 * Encode is passthrough.
 *
 * When to use this:
 * - Normalizing strings to lowercase (e.g. email addresses).
 *
 * Behavior:
 * - Decode: applies `String.prototype.toLowerCase()`.
 * - Encode: passthrough.
 * - Not round-trippable if the original had uppercase characters.
 *
 * **Example** (Lowercasing on decode)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const Lowered = Schema.String.pipe(
 *   Schema.decode(SchemaTransformation.toLowerCase())
 * )
 * ```
 *
 * See also:
 * - {@link toUpperCase}
 * - {@link trim}
 *
 * @category String transformations
 * @since 4.0.0
 */
export function toLowerCase(): Transformation<string, string> {
  return new Transformation(
    Getter.toLowerCase(),
    Getter.passthrough()
  )
}

/**
 * A string-to-string transformation that uppercases on decode.
 * Encode is passthrough.
 *
 * When to use this:
 * - Normalizing strings to uppercase (e.g. country codes).
 *
 * Behavior:
 * - Decode: applies `String.prototype.toUpperCase()`.
 * - Encode: passthrough.
 * - Not round-trippable if the original had lowercase characters.
 *
 * **Example** (Uppercasing on decode)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const Uppered = Schema.String.pipe(
 *   Schema.decode(SchemaTransformation.toUpperCase())
 * )
 * ```
 *
 * See also:
 * - {@link toLowerCase}
 * - {@link trim}
 *
 * @category String transformations
 * @since 4.0.0
 */
export function toUpperCase(): Transformation<string, string> {
  return new Transformation(
    Getter.toUpperCase(),
    Getter.passthrough()
  )
}

/**
 * A string-to-string transformation that capitalizes the first character on
 * decode. Encode is passthrough.
 *
 * When to use this:
 * - Normalizing display names or titles.
 *
 * Behavior:
 * - Decode: uppercases the first character, leaves the rest unchanged.
 * - Encode: passthrough.
 *
 * **Example** (Capitalizing on decode)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const Capitalized = Schema.String.pipe(
 *   Schema.decode(SchemaTransformation.capitalize())
 * )
 * ```
 *
 * See also:
 * - {@link uncapitalize}
 * - {@link toUpperCase}
 *
 * @category String transformations
 * @since 4.0.0
 */
export function capitalize(): Transformation<string, string> {
  return new Transformation(
    Getter.capitalize(),
    Getter.passthrough()
  )
}

/**
 * A string-to-string transformation that lowercases the first character on
 * decode. Encode is passthrough.
 *
 * When to use this:
 * - Normalizing identifiers or field names.
 *
 * Behavior:
 * - Decode: lowercases the first character, leaves the rest unchanged.
 * - Encode: passthrough.
 *
 * **Example** (Uncapitalizing on decode)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const Uncapitalized = Schema.String.pipe(
 *   Schema.decode(SchemaTransformation.uncapitalize())
 * )
 * ```
 *
 * See also:
 * - {@link capitalize}
 * - {@link toLowerCase}
 *
 * @category String transformations
 * @since 4.0.0
 */
export function uncapitalize(): Transformation<string, string> {
  return new Transformation(
    Getter.uncapitalize(),
    Getter.passthrough()
  )
}

/**
 * A transformation that decodes a string into a record of key-value pairs and
 * encodes a record of key-value pairs into a string.
 *
 * When to use this:
 * - Parsing query-string-like or config-file-like strings into records.
 *
 * Behavior:
 * - Decode: splits the string by `separator` (default `","`) into pairs,
 *   then splits each pair by `keyValueSeparator` (default `"="`).
 * - Encode: joins the record back into a string using the same separators.
 * - Round-trippable when keys and values don't contain the separators.
 *
 * **Example** (Parsing key-value pairs)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const Config = Schema.String.pipe(
 *   Schema.decodeTo(
 *     Schema.Record(Schema.String, Schema.String),
 *     SchemaTransformation.splitKeyValue({ separator: ";", keyValueSeparator: ":" })
 *   )
 * )
 * // "host:localhost;port:3000" → { host: "localhost", port: "3000" }
 * ```
 *
 * See also:
 * - {@link trim}
 * - {@link snakeToCamel}
 *
 * @category String transformations
 * @since 4.0.0
 */
export function splitKeyValue(options?: {
  readonly separator?: string | undefined
  readonly keyValueSeparator?: string | undefined
}): Transformation<Record<string, string>, string> {
  return new Transformation(
    Getter.splitKeyValue(options),
    Getter.joinKeyValue(options)
  )
}

const passthrough_ = new Transformation(
  Getter.passthrough<any>(),
  Getter.passthrough<any>()
)

/**
 * The identity transformation — returns the input unchanged in both
 * directions.
 *
 * When to use this:
 * - Connecting two schemas that share the same type with no conversion.
 * - As a placeholder when `Schema.decodeTo` requires a transformation but
 *   no actual conversion is needed.
 *
 * Behavior:
 * - Both decode and encode are no-ops.
 * - Returns a shared singleton instance (no allocation per call).
 * - By default, `T` and `E` must be the same type. Pass `{ strict: false }`
 *   to bypass the type constraint.
 *
 * **Example** (Chaining schemas with no conversion)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.Trim.pipe(
 *   Schema.decodeTo(Schema.FiniteFromString, SchemaTransformation.passthrough())
 * )
 * ```
 *
 * See also:
 * - {@link passthroughSupertype}
 * - {@link passthroughSubtype}
 * - {@link transform}
 *
 * @since 4.0.0
 */
export function passthrough<T, E>(options: { readonly strict: false }): Transformation<T, E>
export function passthrough<T>(): Transformation<T, T>
export function passthrough<T>(): Transformation<T, T> {
  return passthrough_
}

/**
 * A passthrough transformation typed so that `T extends E` — the decoded
 * type is a supertype of the encoded type.
 *
 * When to use this:
 * - Widening: the decoded side accepts a broader type than the encoded side.
 *
 * Behavior:
 * - Both decode and encode are no-ops (same as {@link passthrough}).
 * - Returns a shared singleton instance.
 *
 * **Example** (Supertype passthrough)
 *
 * ```ts
 * import { SchemaTransformation } from "effect"
 *
 * const t = SchemaTransformation.passthroughSupertype<"a" | "b", string>()
 * ```
 *
 * See also:
 * - {@link passthrough}
 * - {@link passthroughSubtype}
 *
 * @since 4.0.0
 */
export function passthroughSupertype<T extends E, E>(): Transformation<T, E>
export function passthroughSupertype<T>(): Transformation<T, T> {
  return passthrough_
}

/**
 * A passthrough transformation typed so that `E extends T` — the encoded
 * type is a subtype of the decoded type.
 *
 * When to use this:
 * - Narrowing: the encoded side is more specific than the decoded side.
 *
 * Behavior:
 * - Both decode and encode are no-ops (same as {@link passthrough}).
 * - Returns a shared singleton instance.
 *
 * **Example** (Subtype passthrough)
 *
 * ```ts
 * import { SchemaTransformation } from "effect"
 *
 * const t = SchemaTransformation.passthroughSubtype<string, "a" | "b">()
 * ```
 *
 * See also:
 * - {@link passthrough}
 * - {@link passthroughSupertype}
 *
 * @since 4.0.0
 */
export function passthroughSubtype<T, E extends T>(): Transformation<T, E>
export function passthroughSubtype<T>(): Transformation<T, T> {
  return passthrough_
}

/**
 * Decodes a `string` into a `number` and encodes a `number` back to a
 * `string`.
 *
 * When to use this:
 * - Parsing numeric strings from APIs, form data, or URL parameters.
 *
 * Behavior:
 * - Decode: coerces the string to a number (like `Number(s)`).
 * - Encode: coerces the number to a string (like `String(n)`).
 * - Does not validate that the result is finite — combine with
 *   `Schema.Finite` or `Schema.Int` for stricter checks.
 *
 * **Example** (Number from string)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.String.pipe(
 *   Schema.decodeTo(Schema.Number, SchemaTransformation.numberFromString)
 * )
 * ```
 *
 * See also:
 * - {@link bigintFromString}
 * - {@link transform}
 *
 * @category Coercions
 * @since 4.0.0
 */
export const numberFromString = new Transformation(
  Getter.Number(),
  Getter.String()
)

/**
 * Decodes a `string` into a `bigint` and encodes a `bigint` back to a
 * `string`.
 *
 * When to use this:
 * - Parsing large integer strings (e.g. database IDs, blockchain values).
 *
 * Behavior:
 * - Decode: coerces the string to a bigint (like `BigInt(s)`).
 * - Encode: coerces the bigint to a string (like `String(n)`).
 * - Fails on decode if the string is not a valid bigint representation.
 *
 * **Example** (BigInt from string)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.String.pipe(
 *   Schema.decodeTo(Schema.BigInt, SchemaTransformation.bigintFromString)
 * )
 * ```
 *
 * See also:
 * - {@link numberFromString}
 * - {@link transform}
 *
 * @category Coercions
 * @since 4.0.0
 */
export const bigintFromString = new Transformation(
  Getter.BigInt(),
  Getter.String()
)

/**
 * Decodes a `bigint` (nanoseconds) into a `Duration` and encodes a
 * `Duration` back to `bigint` nanoseconds.
 *
 * When to use this:
 * - Working with nanosecond-precision timestamps or intervals.
 *
 * Behavior:
 * - Decode: always succeeds, creating a Duration from nanoseconds.
 * - Encode: fails with `InvalidValue` if the Duration cannot be represented
 *   as a `bigint` (e.g. `Duration.infinity`).
 *
 * **Example** (Duration from nanoseconds)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.BigInt.pipe(
 *   Schema.decodeTo(Schema.Duration, SchemaTransformation.durationFromNanos)
 * )
 * ```
 *
 * See also:
 * - {@link durationFromMillis}
 *
 * @since 4.0.0
 */
export const durationFromNanos: Transformation<Duration.Duration, bigint> = transformOrFail({
  decode: (i) => Effect.succeed(Duration.nanos(i)),
  encode: (a) =>
    Option.match(Duration.toNanos(a), {
      onNone: () =>
        Effect.fail(
          new Issue.InvalidValue(Option.some(a), { message: `Unable to encode ${a} into a bigint` })
        ),
      onSome: (nanos) => Effect.succeed(nanos)
    })
})

/**
 * Decodes a `number` (milliseconds) into a `Duration` and encodes a
 * `Duration` back to `number` milliseconds.
 *
 * When to use this:
 * - Working with millisecond-precision timestamps (e.g. `Date.now()`).
 *
 * Behavior:
 * - Decode: creates a Duration from milliseconds. Always succeeds.
 * - Encode: converts a Duration to milliseconds. Always succeeds.
 *
 * **Example** (Duration from milliseconds)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.Number.pipe(
 *   Schema.decodeTo(Schema.Duration, SchemaTransformation.durationFromMillis)
 * )
 * ```
 *
 * See also:
 * - {@link durationFromNanos}
 *
 * @since 4.0.0
 */
export const durationFromMillis: Transformation<Duration.Duration, number> = transform({
  decode: (i) => Duration.millis(i),
  encode: (a) => Duration.toMillis(a)
})

/** @internal */
export const errorFromErrorJsonEncoded = (options?: {
  readonly includeStack?: boolean | undefined
}): Transformation<Error, {
  message: string
  name?: string
  stack?: string
}> =>
  transform({
    decode: (i) => {
      const err = new Error(i.message)
      if (typeof i.name === "string" && i.name !== "Error") err.name = i.name
      if (typeof i.stack === "string") err.stack = i.stack
      return err
    },
    encode: (a) => {
      const e: {
        message: string
        name?: string
        stack?: string
      } = {
        name: a.name,
        message: a.message
      }
      if (options?.includeStack && typeof a.stack === "string") {
        e.stack = a.stack
      }
      return e
    }
  })

/**
 * Decodes `T | null` into `Option<T>` and encodes `Option<T>` back to
 * `T | null`.
 *
 * When to use this:
 * - Converting nullable API fields to `Option`.
 *
 * Behavior:
 * - Decode: `null` → `Option.none()`, non-null → `Option.some(value)`.
 * - Encode: `Option.none()` → `null`, `Option.some(value)` → `value`.
 * - Pure and synchronous.
 *
 * **Example** (Option from nullable)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.NullOr(Schema.String).pipe(
 *   Schema.decodeTo(
 *     Schema.Option(Schema.String),
 *     SchemaTransformation.optionFromNullOr()
 *   )
 * )
 * ```
 *
 * See also:
 * - {@link optionFromNullishOr}
 *
 * @since 4.0.0
 */
export function optionFromNullOr<T>(): Transformation<Option.Option<T>, T | null> {
  return transform({
    decode: Option.fromNullOr,
    encode: Option.getOrNull
  })
}

/**
 * Decodes `T | undefined` into `Option<T>` and encodes `Option<T>` back
 * to `T | undefined`.
 *
 * When to use this:
 * - Converting undefined-or API fields to `Option`.
 *
 * Behavior:
 * - Decode: `undefined` → `Option.none()`, non-undefined → `Option.some(value)`.
 * - Encode: `Option.none()` → `undefined`, `Option.some(value)` → `value`.
 * - Pure and synchronous.
 *
 * **Example** (Option from undefined-or)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.UndefinedOr(Schema.String).pipe(
 *   Schema.decodeTo(
 *     Schema.Option(Schema.String),
 *     SchemaTransformation.optionFromUndefinedOr()
 *   )
 * )
 * ```
 *
 * See also:
 * - {@link optionFromOptionalKey}
 * - {@link optionFromOptional}
 *
 * @since 4.0.0
 */
export function optionFromUndefinedOr<T>(): Transformation<Option.Option<T>, T | undefined> {
  return transform({
    decode: Option.fromUndefinedOr,
    encode: Option.getOrUndefined
  })
}

/**
 * Decodes `T | null | undefined` into `Option<T>` and encodes `Option<T>`
 * back to `T | null` or `T | undefined` depending on the provided `options.onNoneEncoding` (defaults to `undefined`).
 *
 * When to use this:
 * - Converting nullish API fields to `Option` when both `null` and
 *   `undefined` represent absence.
 *
 * Behavior:
 * - Decode: `null` or `undefined` → `Option.none()`, otherwise → `Option.some(value)`.
 * - Encode: `Option.none()` → `null` or `undefined` (per `options.onNoneEncoding`),
 *   `Option.some(value)` → `value`.
 * - Pure and synchronous.
 *
 * **Example** (Option from nullish, encoding None as null)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.NullishOr(Schema.String).pipe(
 *   Schema.decodeTo(
 *     Schema.Option(Schema.String),
 *     SchemaTransformation.optionFromNullishOr({ onNoneEncoding: null })
 *   )
 * )
 * ```
 *
 * See also:
 * - {@link optionFromNullOr}
 * - {@link optionFromUndefinedOr}
 *
 * @since 4.0.0
 */
export function optionFromNullishOr<T>(
  options?: {
    onNoneEncoding: null | undefined
  }
): Transformation<Option.Option<T>, T | null | undefined> {
  return transform({
    decode: Option.fromNullishOr,
    encode: options?.onNoneEncoding === null ? Option.getOrNull : Option.getOrUndefined
  })
}

/**
 * Decodes an optional struct key into `Option<T>` and encodes `Option<T>`
 * back to an optional key.
 *
 * When to use this:
 * - Converting optional struct keys (declared with `Schema.optionalKey`) to
 *   `Option` values.
 *
 * Behavior:
 * - Decode: absent key (`None`) → `Some(None)`, present key (`Some(v)`) → `Some(Some(v))`.
 * - Encode: `Some(None)` → `None` (omit key), `Some(Some(v))` → `Some(v)`.
 * - Uses `transformOptional` under the hood.
 *
 * **Example** (Optional key to Option)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.Struct({
 *   name: Schema.optionalKey(Schema.String).pipe(
 *     Schema.decodeTo(
 *       Schema.Option(Schema.String),
 *       SchemaTransformation.optionFromOptionalKey()
 *     )
 *   )
 * })
 * ```
 *
 * See also:
 * - {@link optionFromOptional}
 * - {@link optionFromUndefinedOr}
 * - {@link transformOptional}
 *
 * @since 4.0.0
 */
export function optionFromOptionalKey<T>(): Transformation<Option.Option<T>, T> {
  return transformOptional({
    decode: Option.some,
    encode: Option.flatten
  })
}

/**
 * Decodes `T | undefined` into `Option<T>` and encodes `Option<T>` back
 * to `T | undefined`.
 *
 * When to use this:
 * - Converting optional (possibly `undefined`) values to `Option`.
 *
 * Behavior:
 * - Decode: absent or `undefined` → `Some(None)`, present → `Some(Some(v))`.
 * - Encode: `Some(None)` → `None` (omit), `Some(Some(v))` → `Some(v)`.
 * - Uses `transformOptional` under the hood; filters out `undefined` on decode.
 *
 * **Example** (Optional value to Option)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.Struct({
 *   age: Schema.optional(Schema.Number).pipe(
 *     Schema.decodeTo(
 *       Schema.Option(Schema.Number),
 *       SchemaTransformation.optionFromOptional()
 *     )
 *   )
 * })
 * ```
 *
 * See also:
 * - {@link optionFromOptionalKey}
 * - {@link optionFromUndefinedOr}
 * - {@link transformOptional}
 *
 * @since 4.0.0
 */
export function optionFromOptional<T>(): Transformation<Option.Option<T>, T | undefined> {
  return transformOptional<Option.Option<T>, T | undefined>({
    decode: (ot) => ot.pipe(Option.filter(Predicate.isNotUndefined), Option.some),
    encode: Option.flatten
  })
}

/**
 * Decodes a `string` into a `URL` and encodes a `URL` back to its `href`
 * string.
 *
 * When to use this:
 * - Parsing URL strings from user input or API responses.
 *
 * Behavior:
 * - Decode: calls `new URL(s)`. Fails with `InvalidValue` if the string
 *   is not a valid URL.
 * - Encode: returns `url.href`.
 *
 * **Example** (URL from string)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.String.pipe(
 *   Schema.decodeTo(Schema.URL, SchemaTransformation.urlFromString)
 * )
 * ```
 *
 * See also:
 * - {@link numberFromString}
 * - {@link transformOrFail}
 *
 * @since 4.0.0
 */
export const urlFromString: Transformation<URL, string> = transformOrFail<URL, string>({
  decode: (s) =>
    Effect.try({
      try: () => new URL(s),
      catch: (e) => new Issue.InvalidValue(Option.some(s), { message: globalThis.String(e) })
    }),
  encode: (url) => Effect.succeed(url.href)
})

/**
 * Decodes a `string` into a `BigDecimal` and encodes a `BigDecimal` back to
 * its string representation.
 *
 * When to use this:
 * - Parsing decimal number strings from APIs or user input.
 *
 * Behavior:
 * - Decode: calls `BigDecimal.fromString(s)`. Fails with `InvalidValue` if the
 *   string is not a valid BigDecimal representation.
 * - Encode: returns `BigDecimal.format(bd)`.
 *
 * @since 4.0.0
 */
export const bigDecimalFromString: Transformation<BigDecimal.BigDecimal, string> = transformOrFail<
  BigDecimal.BigDecimal,
  string
>({
  decode: (s) => {
    const result = BigDecimal.fromString(s)
    return Option.isNone(result)
      ? Effect.fail(new Issue.InvalidValue(Option.some(s), { message: `Invalid BigDecimal string: ${s}` }))
      : Effect.succeed(result.value)
  },
  encode: (bd) => Effect.succeed(BigDecimal.format(bd))
})

/**
 * Decodes a Base64-encoded `string` into a `Uint8Array` and encodes a
 * `Uint8Array` back to a Base64 string.
 *
 * When to use this:
 * - Handling binary data transmitted as Base64 strings (e.g. file uploads,
 *   API payloads).
 *
 * Behavior:
 * - Decode: parses the Base64 string into bytes.
 * - Encode: encodes the byte array as a Base64 string.
 *
 * **Example** (Uint8Array from Base64)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.String.pipe(
 *   Schema.decodeTo(Schema.Uint8Array, SchemaTransformation.uint8ArrayFromBase64String)
 * )
 * ```
 *
 * See also:
 * - {@link fromJsonString}
 *
 * @since 4.0.0
 */
export const uint8ArrayFromBase64String: Transformation<Uint8Array<ArrayBufferLike>, string> = new Transformation(
  Getter.decodeBase64(),
  Getter.encodeBase64()
)

/**
 * Decodes a JSON `string` into an `unknown` value and encodes an `unknown`
 * value back to a JSON string.
 *
 * When to use this:
 * - Parsing JSON strings from HTTP bodies, message queues, or storage.
 * - Typically composed with a further schema to validate the parsed structure.
 *
 * Behavior:
 * - Decode: calls `JSON.parse`. Fails if the string is not valid JSON.
 * - Encode: calls `JSON.stringify`.
 *
 * **Example** (Parsing JSON)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.String.pipe(
 *   Schema.decodeTo(Schema.Unknown, SchemaTransformation.fromJsonString)
 * )
 * ```
 *
 * See also:
 * - {@link uint8ArrayFromBase64String}
 * - {@link fromFormData}
 *
 * @since 4.0.0
 */
export const fromJsonString = new Transformation<unknown, string>(
  Getter.parseJson(),
  Getter.stringifyJson()
)

/**
 * Decodes a `FormData` instance into an `unknown` record and encodes an
 * `unknown` record back to `FormData`.
 *
 * When to use this:
 * - Handling HTML form submissions or multipart API requests.
 *
 * Behavior:
 * - Decode: extracts entries from the FormData into a plain object.
 * - Encode: constructs a FormData from the record's entries.
 *
 * **Example** (Decoding FormData)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.instanceOf(FormData).pipe(
 *   Schema.decodeTo(Schema.Unknown, SchemaTransformation.fromFormData)
 * )
 * ```
 *
 * See also:
 * - {@link fromURLSearchParams}
 * - {@link fromJsonString}
 *
 * @since 4.0.0
 */
export const fromFormData = new Transformation<unknown, FormData>(
  Getter.decodeFormData(),
  Getter.encodeFormData()
)

/**
 * Decodes a `URLSearchParams` instance into an `unknown` record and encodes
 * an `unknown` record back to `URLSearchParams`.
 *
 * When to use this:
 * - Parsing URL query parameters.
 *
 * Behavior:
 * - Decode: extracts entries from URLSearchParams into a plain object.
 * - Encode: constructs URLSearchParams from the record's entries.
 *
 * **Example** (Decoding URLSearchParams)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.instanceOf(URLSearchParams).pipe(
 *   Schema.decodeTo(Schema.Unknown, SchemaTransformation.fromURLSearchParams)
 * )
 * ```
 *
 * See also:
 * - {@link fromFormData}
 * - {@link fromJsonString}
 *
 * @since 4.0.0
 */
export const fromURLSearchParams = new Transformation<unknown, URLSearchParams>(
  Getter.decodeURLSearchParams(),
  Getter.encodeURLSearchParams()
)

/**
 * @since 4.0.0
 */
export const timeZoneOffsetFromNumber: Transformation<DateTime.TimeZone.Offset, number> = transform<
  DateTime.TimeZone.Offset,
  number
>({
  decode: (n) => DateTime.zoneMakeOffset(n),
  encode: (tz) => tz.offset
})

/**
 * @since 4.0.0
 */
export const timeZoneNamedFromString: Transformation<DateTime.TimeZone.Named, string> = transformOrFail<
  DateTime.TimeZone.Named,
  string
>({
  decode: (s) => {
    return Option.match(DateTime.zoneMakeNamed(s), {
      onNone: () => Effect.fail(new Issue.InvalidValue(Option.some(s), { message: `Invalid IANA time zone: ${s}` })),
      onSome: Effect.succeed
    })
  },
  encode: (tz) => Effect.succeed(tz.id)
})

/**
 * @since 4.0.0
 */
export const timeZoneFromString: Transformation<DateTime.TimeZone, string> = transformOrFail<
  DateTime.TimeZone,
  string
>({
  decode: (s) => {
    return Option.match(DateTime.zoneFromString(s), {
      onNone: () => Effect.fail(new Issue.InvalidValue(Option.some(s), { message: `Invalid time zone: ${s}` })),
      onSome: Effect.succeed
    })
  },
  encode: (tz) => Effect.succeed(DateTime.zoneToString(tz))
})

/**
 * @since 4.0.0
 */
export const dateTimeUtcFromString: Transformation<DateTime.Utc, string> = transformOrFail<
  DateTime.Utc,
  string
>({
  decode: (s) => {
    return Option.match(DateTime.make(s), {
      onNone: () => Effect.fail(new Issue.InvalidValue(Option.some(s), { message: "Invalid DateTime input" })),
      onSome: (result) => Effect.succeed(DateTime.toUtc(result))
    })
  },
  encode: (utc) => Effect.succeed(DateTime.formatIso(utc))
})

/**
 * @since 4.0.0
 */
export const dateTimeZonedFromString: Transformation<DateTime.Zoned, string> = transformOrFail<
  DateTime.Zoned,
  string
>({
  decode: (s) => {
    return Option.match(DateTime.makeZonedFromString(s), {
      onNone: () =>
        Effect.fail(new Issue.InvalidValue(Option.some(s), { message: `Invalid zoned DateTime string: ${s}` })),
      onSome: Effect.succeed
    })
  },
  encode: (zoned) => Effect.succeed(DateTime.formatIsoZoned(zoned))
})
