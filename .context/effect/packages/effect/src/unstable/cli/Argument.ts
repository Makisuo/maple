/**
 * @since 4.0.0
 */
import type * as Config from "../../Config.ts"
import type * as Effect from "../../Effect.ts"
import { dual, type LazyArg } from "../../Function.ts"
import type * as Option from "../../Option.ts"
import type * as Redacted from "../../Redacted.ts"
import type * as Result from "../../Result.ts"
import type * as Schema from "../../Schema.ts"
import type * as CliError from "./CliError.ts"
import * as Param from "./Param.ts"
import type * as Primitive from "./Primitive.ts"

// -------------------------------------------------------------------------------------
// models
// -------------------------------------------------------------------------------------

/**
 * Represents a positional command-line argument.
 *
 * Note: `boolean` is intentionally omitted from Argument constructors.
 * Positional boolean arguments are ambiguous in CLI design since there's
 * no flag name to negate (e.g., `--no-verbose`). Use Flag.boolean instead,
 * or use Argument.choice with explicit "true"/"false" strings if needed.
 *
 * @since 4.0.0
 * @category models
 */
export interface Argument<A> extends Param.Param<typeof Param.argumentKind, A> {}

// -------------------------------------------------------------------------------------
// constructors
// -------------------------------------------------------------------------------------

/**
 * Creates a positional string argument.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * const filename = Argument.string("filename")
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const string = (name: string): Argument<string> => Param.string(Param.argumentKind, name)

/**
 * Creates a positional integer argument.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * const count = Argument.integer("count")
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const integer = (name: string): Argument<number> => Param.integer(Param.argumentKind, name)

/**
 * Creates a positional file path argument.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * const inputFile = Argument.file("input", { mustExist: true }) // Must exist
 * const outputFile = Argument.file("output", { mustExist: false }) // Must not exist
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const file = (name: string, options?: {
  readonly mustExist?: boolean | undefined
}): Argument<string> => Param.file(Param.argumentKind, name, options)

/**
 * Creates a positional directory path argument.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * const workspace = Argument.directory("workspace", { mustExist: true }) // Must exist
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const directory = (name: string, options?: {
  readonly mustExist?: boolean | undefined
}): Argument<string> => Param.directory(Param.argumentKind, name, options)

/**
 * Creates a positional float argument.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * const ratio = Argument.float("ratio")
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const float = (name: string): Argument<number> => Param.float(Param.argumentKind, name)

/**
 * Creates a positional date argument.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * const startDate = Argument.date("start-date")
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const date = (name: string): Argument<Date> => Param.date(Param.argumentKind, name)

/**
 * Creates a positional choice argument.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * const environment = Argument.choice("environment", ["dev", "staging", "prod"])
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const choice = <const Choices extends ReadonlyArray<string>>(
  name: string,
  choices: Choices
): Argument<Choices[number]> => Param.choice(Param.argumentKind, name, choices)

/**
 * Creates a positional path argument.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * const configPath = Argument.path("config")
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const path = (name: string, options?: {
  pathType?: "file" | "directory" | "either"
  mustExist?: boolean
}): Argument<string> => Param.path(Param.argumentKind, name, options)

/**
 * Creates a positional redacted argument that obscures its value.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * const secret = Argument.redacted("secret")
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const redacted = (name: string): Argument<Redacted.Redacted<string>> => Param.redacted(Param.argumentKind, name)

/**
 * Creates a positional argument that reads file content as a string.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * const config = Argument.fileText("config-file")
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const fileText = (name: string): Argument<string> => Param.fileText(Param.argumentKind, name)

/**
 * Creates a positional argument that reads and validates file content using a schema.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * const config = Argument.fileParse("config", { format: "json" })
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const fileParse = (
  name: string,
  options?: Primitive.FileParseOptions | undefined
): Argument<unknown> => Param.fileParse(Param.argumentKind, name, options)

/**
 * Creates a positional argument that reads and validates file content using a schema.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Argument } from "effect/unstable/cli"
 *
 * const ConfigSchema = Schema.Struct({
 *   port: Schema.Number,
 *   host: Schema.String
 * })
 *
 * const config = Argument.fileSchema("config", ConfigSchema)
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const fileSchema = <A>(
  name: string,
  schema: Schema.Decoder<A>,
  options?: Primitive.FileSchemaOptions | undefined
): Argument<A> => Param.fileSchema(Param.argumentKind, name, schema, options)

/**
 * Creates an empty sentinel argument that always fails to parse.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * // Used as a placeholder or default in combinators
 * const noArg = Argument.none
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const none: Argument<never> = Param.none(Param.argumentKind)

// -------------------------------------------------------------------------------------
// combinators
// -------------------------------------------------------------------------------------

/**
 * Makes a positional argument optional.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * const optionalVersion = Argument.string("version").pipe(Argument.optional)
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const optional = <A>(arg: Argument<A>): Argument<Option.Option<A>> => Param.optional(arg)

/**
 * Adds a description to a positional argument.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * const filename = Argument.string("filename").pipe(
 *   Argument.withDescription("The input file to process")
 * )
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const withDescription: {
  <A>(description: string): (self: Argument<A>) => Argument<A>
  <A>(self: Argument<A>, description: string): Argument<A>
} = dual(2, <A>(self: Argument<A>, description: string) => Param.withDescription(self, description))

/**
 * Provides a default value for a positional argument.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * const port = Argument.integer("port").pipe(Argument.withDefault(8080))
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const withDefault: {
  <const B>(
    defaultValue: B | Effect.Effect<B, CliError.CliError, Param.Environment>
  ): <A>(self: Argument<A>) => Argument<A | B>
  <A, const B>(
    self: Argument<A>,
    defaultValue: B | Effect.Effect<B, CliError.CliError, Param.Environment>
  ): Argument<A | B>
} = Param.withDefault

/**
 * Adds a fallback config that is loaded when a required argument is missing.
 *
 * @example
 * ```ts
 * import { Config } from "effect"
 * import { Argument } from "effect/unstable/cli"
 *
 * const repository = Argument.string("repository").pipe(
 *   Argument.withFallbackConfig(Config.string("REPOSITORY"))
 * )
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const withFallbackConfig: {
  <B>(config: Config.Config<B>): <A>(self: Argument<A>) => Argument<A | B>
  <A, B>(self: Argument<A>, config: Config.Config<B>): Argument<A | B>
} = dual(2, <A, B>(self: Argument<A>, config: Config.Config<B>) => Param.withFallbackConfig(self, config))

/**
 * Adds a fallback prompt that is shown when a required argument is missing.
 *
 * @example
 * ```ts
 * import { Argument, Prompt } from "effect/unstable/cli"
 *
 * const filename = Argument.string("filename").pipe(
 *   Argument.withFallbackPrompt(Prompt.text({ message: "Filename" }))
 * )
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const withFallbackPrompt: {
  <B>(prompt: Param.FallbackPrompt<B>): <A>(self: Argument<A>) => Argument<A | B>
  <A, B>(self: Argument<A>, prompt: Param.FallbackPrompt<B>): Argument<A | B>
} = dual(2, <A, B>(self: Argument<A>, prompt: Param.FallbackPrompt<B>) => Param.withFallbackPrompt(self, prompt))

/**
 * Creates a variadic positional argument that accepts multiple values.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * // Accept any number of files
 * const anyFiles = Argument.string("files").pipe(Argument.variadic)
 *
 * // Accept at least 1 file
 * const atLeastOneFile = Argument.string("files").pipe(
 *   Argument.variadic({ min: 1 })
 * )
 *
 * // Accept between 1 and 5 files
 * const limitedFiles = Argument.string("files").pipe(
 *   Argument.variadic({ min: 1, max: 5 })
 * )
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const variadic: {
  (options?: Param.VariadicParamOptions | undefined): <A>(self: Argument<A>) => Argument<ReadonlyArray<A>>
  <A>(self: Argument<A>, options?: Param.VariadicParamOptions | undefined): Argument<ReadonlyArray<A>>
} = dual(2, <A>(
  self: Argument<A>,
  options?: Param.VariadicParamOptions | undefined
): Argument<ReadonlyArray<A>> => Param.variadic(self, options))

/**
 * Transforms the parsed value of a positional argument.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * const port = Argument.integer("port").pipe(
 *   Argument.map((p) => ({ port: p, url: `http://localhost:${p}` }))
 * )
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const map: {
  <A, B>(f: (a: A) => B): (self: Argument<A>) => Argument<B>
  <A, B>(self: Argument<A>, f: (a: A) => B): Argument<B>
} = dual(2, <A, B>(self: Argument<A>, f: (a: A) => B) => Param.map(self, f))

/**
 * Transforms the parsed value of a positional argument using an effectful function.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Argument, CliError } from "effect/unstable/cli"
 *
 * const files = Argument.string("files").pipe(
 *   Argument.mapEffect((file) =>
 *     file.endsWith(".txt")
 *       ? Effect.succeed(file)
 *       : Effect.fail(
 *         new CliError.UserError({
 *           cause: new Error("Only .txt files allowed")
 *         })
 *       )
 *   )
 * )
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const mapEffect: {
  <A, B>(
    f: (a: A) => Effect.Effect<B, CliError.CliError, Param.Environment>
  ): (self: Argument<A>) => Argument<B>
  <A, B>(
    self: Argument<A>,
    f: (a: A) => Effect.Effect<B, CliError.CliError, Param.Environment>
  ): Argument<B>
} = dual(2, <A, B>(
  self: Argument<A>,
  f: (a: A) => Effect.Effect<B, CliError.CliError, Param.Environment>
) => Param.mapEffect(self, f))

/**
 * Transforms the parsed value of a positional argument using a function that may throw.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * const json = Argument.string("data").pipe(
 *   Argument.mapTryCatch(
 *     (str) => JSON.parse(str),
 *     (error) =>
 *       `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`
 *   )
 * )
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const mapTryCatch: {
  <A, B>(
    f: (a: A) => B,
    onError: (error: unknown) => string
  ): (self: Argument<A>) => Argument<B>
  <A, B>(self: Argument<A>, f: (a: A) => B, onError: (error: unknown) => string): Argument<B>
} = dual(3, <A, B>(
  self: Argument<A>,
  f: (a: A) => B,
  onError: (error: unknown) => string
) => Param.mapTryCatch(self, f, onError))

/**
 * Creates a variadic argument that requires at least n values.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * const files = Argument.string("files").pipe(Argument.atLeast(1))
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const atLeast: {
  <A>(min: number): (self: Argument<A>) => Argument<ReadonlyArray<A>>
  <A>(self: Argument<A>, min: number): Argument<ReadonlyArray<A>>
} = dual(2, <A>(self: Argument<A>, min: number) => Param.atLeast(self, min))

/**
 * Creates a variadic argument that accepts at most n values.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * const files = Argument.string("files").pipe(Argument.atMost(5))
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const atMost: {
  <A>(max: number): (self: Argument<A>) => Argument<ReadonlyArray<A>>
  <A>(self: Argument<A>, max: number): Argument<ReadonlyArray<A>>
} = dual(2, <A>(self: Argument<A>, max: number) => Param.atMost(self, max))

/**
 * Creates a variadic argument that accepts between min and max values.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * const files = Argument.string("files").pipe(Argument.between(1, 5))
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const between: {
  <A>(min: number, max: number): (self: Argument<A>) => Argument<ReadonlyArray<A>>
  <A>(self: Argument<A>, min: number, max: number): Argument<ReadonlyArray<A>>
} = dual(3, <A>(self: Argument<A>, min: number, max: number) => Param.between(self, min, max))

/**
 * Validates parsed values against a Schema.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Argument } from "effect/unstable/cli"
 *
 * const input = Argument.string("input").pipe(
 *   Argument.withSchema(Schema.NonEmptyString)
 * )
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const withSchema: {
  <A, B>(schema: Schema.Codec<B, A>): (self: Argument<A>) => Argument<B>
  <A, B>(self: Argument<A>, schema: Schema.Codec<B, A>): Argument<B>
} = dual(2, <A, B>(self: Argument<A>, schema: Schema.Codec<B, A>) => Param.withSchema(self, schema))

/**
 * Creates a positional choice argument with custom value mapping.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * const logLevel = Argument.choiceWithValue("level", [
 *   ["debug", 0],
 *   ["info", 1],
 *   ["warn", 2],
 *   ["error", 3]
 * ])
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const choiceWithValue = <const Choices extends ReadonlyArray<readonly [string, any]>>(
  name: string,
  choices: Choices
): Argument<Choices[number][1]> => Param.choiceWithValue(Param.argumentKind, name, choices)

// -------------------------------------------------------------------------------------
// metadata
// -------------------------------------------------------------------------------------

/**
 * Sets a custom metavar (placeholder name) for the argument in help documentation.
 *
 * The metavar is displayed in usage text to indicate what value the user should provide.
 * For example, `<FILE>` shows `FILE` as the metavar.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * const port = Argument.integer("port").pipe(
 *   Argument.withMetavar("PORT")
 * )
 * ```
 *
 * @since 4.0.0
 * @category metadata
 */
export const withMetavar: {
  <A>(metavar: string): (self: Argument<A>) => Argument<A>
  <A>(self: Argument<A>, metavar: string): Argument<A>
} = dual(2, <A>(self: Argument<A>, metavar: string) => Param.withMetavar(self, metavar))

/**
 * Filters parsed values, failing with a custom error message if the predicate returns false.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * const positiveInt = Argument.integer("count").pipe(
 *   Argument.filter(
 *     (n) => n > 0,
 *     (n) => `Expected positive integer, got ${n}`
 *   )
 * )
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const filter: {
  <A>(predicate: (a: A) => boolean, onFalse: (a: A) => string): (self: Argument<A>) => Argument<A>
  <A>(self: Argument<A>, predicate: (a: A) => boolean, onFalse: (a: A) => string): Argument<A>
} = dual(3, <A>(
  self: Argument<A>,
  predicate: (a: A) => boolean,
  onFalse: (a: A) => string
) => Param.filter(self, predicate, onFalse))

/**
 * Filters and transforms parsed values, failing with a custom error message
 * if the filter function returns None.
 *
 * @example
 * ```ts
 * import { Option } from "effect"
 * import { Argument } from "effect/unstable/cli"
 *
 * const positiveInt = Argument.integer("count").pipe(
 *   Argument.filterMap(
 *     (n) => n > 0 ? Option.some(n) : Option.none(),
 *     (n) => `Expected positive integer, got ${n}`
 *   )
 * )
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const filterMap: {
  <A, B>(f: (a: A) => Option.Option<B>, onNone: (a: A) => string): (self: Argument<A>) => Argument<B>
  <A, B>(self: Argument<A>, f: (a: A) => Option.Option<B>, onNone: (a: A) => string): Argument<B>
} = dual(3, <A, B>(
  self: Argument<A>,
  f: (a: A) => Option.Option<B>,
  onNone: (a: A) => string
) => Param.filterMap(self, f, onNone))

/**
 * Provides a fallback argument to use if this argument fails to parse.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * const value = Argument.integer("value").pipe(
 *   Argument.orElse(() => Argument.string("value"))
 * )
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const orElse: {
  <B>(that: LazyArg<Argument<B>>): <A>(self: Argument<A>) => Argument<A | B>
  <A, B>(self: Argument<A>, that: LazyArg<Argument<B>>): Argument<A | B>
} = dual(2, <A, B>(self: Argument<A>, that: LazyArg<Argument<B>>) => Param.orElse(self, that))

/**
 * Provides a fallback argument, wrapping results in Result to distinguish which succeeded.
 *
 * @example
 * ```ts
 * import { Argument } from "effect/unstable/cli"
 *
 * const source = Argument.file("source").pipe(
 *   Argument.orElseResult(() => Argument.string("url"))
 * )
 * // Returns Result<string, string>
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const orElseResult: {
  <B>(that: LazyArg<Argument<B>>): <A>(self: Argument<A>) => Argument<Result.Result<A, B>>
  <A, B>(self: Argument<A>, that: LazyArg<Argument<B>>): Argument<Result.Result<A, B>>
} = dual(2, <A, B>(self: Argument<A>, that: LazyArg<Argument<B>>) => Param.orElseResult(self, that))
