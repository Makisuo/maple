/**
 * Declarative, schema-driven configuration loading. A `Config<T>` describes
 * how to read and validate a value of type `T` from a `ConfigProvider`. Configs
 * can be composed, transformed, and used directly as Effects.
 *
 * ## Mental model
 *
 * - **Config\<T\>** – a recipe for extracting a typed value from a
 *   `ConfigProvider`. Created via convenience constructors or {@link schema}.
 * - **ConfigProvider** – the backing data source (env vars, JSON, `.env`
 *   files). See the `ConfigProvider` module.
 * - **ConfigError** – wraps either a `SourceError` (provider I/O failure) or
 *   a `SchemaError` (validation / decoding failure).
 * - **parse** – instance method on every `Config` that takes a provider and
 *   returns `Effect<T, ConfigError>`.
 * - **Yieldable** – every `Config` can be yielded inside `Effect.gen`. It
 *   automatically resolves the current `ConfigProvider` from the context.
 *
 * ## Common tasks
 *
 * - Read a single env var → {@link string}, {@link number}, {@link boolean},
 *   {@link int}, {@link port}, {@link url}, {@link date}, {@link duration},
 *   {@link logLevel}, {@link redacted}
 * - Read a structured config → {@link schema} with a `Schema.Struct`
 * - Provide a default → {@link withDefault}
 * - Make a config optional → {@link option}
 * - Transform a value → {@link map} / {@link mapOrFail}
 * - Fall back on error → {@link orElse}
 * - Combine multiple configs → {@link all}
 * - Build from a `Schema.Codec` → {@link schema}
 * - Always succeed or fail → {@link succeed} / {@link fail}
 *
 * ## Gotchas
 *
 * - `withDefault` and `option` only apply when the error is caused by
 *   **missing data**. Validation errors (wrong type, out of range) still
 *   propagate.
 * - When yielded in `Effect.gen`, the config resolves using the current
 *   `ConfigProvider` service. To use a specific provider, call `.parse(provider)`
 *   instead.
 * - The `name` parameter on convenience constructors (e.g. `Config.string("HOST")`)
 *   sets the root path segment. Omit it when the config is part of a larger
 *   schema.
 *
 * ## Quickstart
 *
 * **Example** (Reading typed config from environment variables)
 *
 * ```ts
 * import { Config, ConfigProvider, Effect, Schema } from "effect"
 *
 * const AppConfig = Config.schema(
 *   Schema.Struct({
 *     host: Schema.String,
 *     port: Schema.Int
 *   }),
 *   "app"
 * )
 *
 * const provider = ConfigProvider.fromEnv({
 *   env: { app_host: "localhost", app_port: "8080" }
 * })
 *
 * // Effect.runSync(AppConfig.parse(provider))
 * // { host: "localhost", port: 8080 }
 * ```
 *
 * @see {@link schema} – build a Config from any Schema.Codec
 * @see {@link ConfigError} – the error type for config failures
 * @see {@link make} – low-level Config constructor
 *
 * @since 4.0.0
 */
import type { Path, SourceError } from "./ConfigProvider.ts"
import * as ConfigProvider from "./ConfigProvider.ts"
import * as Duration_ from "./Duration.ts"
import * as Effect from "./Effect.ts"
import { dual } from "./Function.ts"
import { PipeInspectableProto, YieldableProto } from "./internal/core.ts"
import * as LogLevel_ from "./LogLevel.ts"
import * as Option from "./Option.ts"
import type { Pipeable } from "./Pipeable.ts"
import * as Predicate from "./Predicate.ts"
import * as Rec from "./Record.ts"
import * as Schema from "./Schema.ts"
import * as AST from "./SchemaAST.ts"
import * as Getter from "./SchemaGetter.ts"
import * as Issue from "./SchemaIssue.ts"
import * as Parser from "./SchemaParser.ts"
import * as Transformation from "./SchemaTransformation.ts"

const TypeId = "~effect/Config"

/**
 * Returns `true` if `u` is a `Config` instance.
 *
 * When to use:
 * - Runtime type-checking before calling `.parse()` on an unknown value.
 * - Distinguishing a `Config` from a plain value inside {@link unwrap}.
 *
 * **Example** (Type guard)
 *
 * ```ts
 * import { Config } from "effect"
 *
 * console.log(Config.isConfig(Config.string("HOST"))) // true
 * console.log(Config.isConfig("not a config"))        // false
 * ```
 *
 * @since 4.0.0
 * @category Guards
 */
export const isConfig = (u: unknown): u is Config<unknown> => Predicate.hasProperty(u, TypeId)

/**
 * The error type produced when config loading or validation fails.
 *
 * Wraps either:
 * - A `SourceError` — the provider could not read data (I/O failure).
 * - A `SchemaError` — the data was found but did not match the schema
 *   (wrong type, out of range, missing key, etc.).
 *
 * When to use:
 * - Match on `error.cause._tag` to distinguish source failures from
 *   validation failures.
 * - Pass to {@link fail} to create a Config that always errors.
 *
 * @see {@link orElse} – recover from a ConfigError
 * @see {@link withDefault} – provide a fallback for missing-data errors
 *
 * @since 4.0.0
 * @category Models
 */
export class ConfigError {
  readonly _tag = "ConfigError"
  readonly name: string = "ConfigError"
  readonly cause: SourceError | Schema.SchemaError
  constructor(cause: SourceError | Schema.SchemaError) {
    this.cause = cause
  }
  get message() {
    return this.cause.toString()
  }
  toString() {
    return `ConfigError(${this.message})`
  }
}

/**
 * A recipe for extracting a typed value `T` from a `ConfigProvider`.
 *
 * Key members:
 * - `parse(provider)` – runs the config against a specific provider,
 *   returning `Effect<T, ConfigError>`.
 * - Yieldable – can be yielded inside `Effect.gen`, which automatically
 *   resolves the current `ConfigProvider` from the context.
 * - Pipeable – supports `.pipe(Config.map(...))` etc.
 *
 * @see {@link schema} – the main way to create a Config
 * @see {@link make} – low-level constructor
 *
 * @since 4.0.0
 */
export interface Config<out T> extends Pipeable, Effect.Yieldable<Config<T>, T, ConfigError> {
  readonly [TypeId]: typeof TypeId
  readonly parse: (provider: ConfigProvider.ConfigProvider) => Effect.Effect<T, ConfigError>
}

const Proto = {
  ...PipeInspectableProto,
  ...YieldableProto,
  [TypeId]: TypeId,
  asEffect(this: Config<unknown>) {
    return Effect.flatMap(ConfigProvider.ConfigProvider.asEffect(), (provider) => this.parse(provider))
  },
  toJSON(this: Config<unknown>) {
    return {
      _id: "Config"
    }
  }
}

/**
 * Creates a `Config` from a raw parsing function.
 *
 * When to use:
 * - Building a custom config that cannot be expressed with {@link schema} or
 *   the convenience constructors.
 * - Composing configs programmatically.
 *
 * The `parse` callback receives a `ConfigProvider` and must return
 * `Effect<T, ConfigError>`.
 *
 * **Example** (Custom config that reads two keys)
 *
 * ```ts
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const hostPort = Config.make((provider) =>
 *   Effect.all({
 *     host: Config.string("host").parse(provider),
 *     port: Config.number("port").parse(provider)
 *   })
 * )
 *
 * const provider = ConfigProvider.fromUnknown({ host: "localhost", port: 3000 })
 * // Effect.runSync(hostPort.parse(provider))
 * // { host: "localhost", port: 3000 }
 * ```
 *
 * @see {@link schema} – higher-level constructor using Schema codecs
 *
 * @category Constructors
 * @since 4.0.0
 */
export function make<T>(
  parse: (provider: ConfigProvider.ConfigProvider) => Effect.Effect<T, ConfigError>
): Config<T> {
  const self = Object.create(Proto)
  self.parse = parse
  return self
}

/**
 * Transforms the parsed value of a config with a pure function.
 *
 * When to use:
 * - Post-processing a config value (e.g. trimming, uppercasing, wrapping).
 * - The transformation cannot fail. Use {@link mapOrFail} if it can.
 *
 * Supports both data-last and data-first calling conventions.
 *
 * **Example** (Uppercasing a string config)
 *
 * ```ts
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const upper = Config.string("name").pipe(
 *   Config.map((s) => s.toUpperCase())
 * )
 *
 * const provider = ConfigProvider.fromUnknown({ name: "alice" })
 * // Effect.runSync(upper.parse(provider)) // "ALICE"
 * ```
 *
 * @see {@link mapOrFail} – when the transformation can fail
 *
 * @category Mapping
 * @since 4.0.0
 */
export const map: {
  <A, B>(f: (a: A) => B): (self: Config<A>) => Config<B>
  <A, B>(self: Config<A>, f: (a: A) => B): Config<B>
} = dual(2, <A, B>(self: Config<A>, f: (a: A) => B): Config<B> => {
  return make((provider) => Effect.map(self.parse(provider), f))
})

/**
 * Transforms the parsed value with a function that may fail.
 *
 * When to use:
 * - Validating or converting a config value where the transformation can
 *   produce a `ConfigError` (e.g. parsing a URL, checking a range).
 *
 * Supports both data-last and data-first calling conventions.
 *
 * **Example** (Wrapping a value in an effectful transformation)
 *
 * ```ts
 * import { Config, Effect } from "effect"
 *
 * const trimmed = Config.string("name").pipe(
 *   Config.mapOrFail((s) => Effect.succeed(s.trim()))
 * )
 * ```
 *
 * @see {@link map} – when the transformation cannot fail
 *
 * @category Mapping
 * @since 4.0.0
 */
export const mapOrFail: {
  <A, B>(f: (a: A) => Effect.Effect<B, ConfigError>): (self: Config<A>) => Config<B>
  <A, B>(self: Config<A>, f: (a: A) => Effect.Effect<B, ConfigError>): Config<B>
} = dual(2, <A, B>(self: Config<A>, f: (a: A) => Effect.Effect<B, ConfigError>): Config<B> => {
  return make((provider) => Effect.flatMap(self.parse(provider), f))
})

/**
 * Falls back to another config when parsing fails with a `ConfigError`.
 *
 * When to use:
 * - Trying an alternative config source when the primary one errors.
 * - Providing environment-specific overrides.
 *
 * Unlike {@link withDefault}, this catches **all** `ConfigError`s (not just
 * missing data). The fallback function receives the error and returns a new
 * `Config`.
 *
 * Supports both data-last and data-first calling conventions.
 *
 * **Example** (Falling back to a literal)
 *
 * ```ts
 * import { Config } from "effect"
 *
 * const hostConfig = Config.string("HOST").pipe(
 *   Config.orElse(() => Config.succeed("localhost"))
 * )
 * ```
 *
 * @see {@link withDefault} – fallback only on missing data
 *
 * @since 4.0.0
 */
export const orElse: {
  <A2>(that: (error: ConfigError) => Config<A2>): <A>(self: Config<A>) => Config<A2 | A>
  <A, A2>(self: Config<A>, that: (error: ConfigError) => Config<A2>): Config<A | A2>
} = dual(2, <A, A2>(self: Config<A>, that: (error: ConfigError) => Config<A2>): Config<A | A2> => {
  return make((provider) => Effect.catch(self.parse(provider), (error) => that(error).parse(provider)))
})

/**
 * Combines multiple configs into a single config that parses all of them.
 *
 * When to use:
 * - Grouping related configs into a tuple or named struct.
 *
 * Accepts a tuple (preserves positions), an iterable, or a record of configs.
 * Returns a config whose parsed value mirrors the input shape.
 *
 * **Example** (Combining configs as a struct)
 *
 * ```ts
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const dbConfig = Config.all({
 *   host: Config.string("host"),
 *   port: Config.number("port")
 * })
 *
 * const provider = ConfigProvider.fromUnknown({ host: "localhost", port: 5432 })
 * // Effect.runSync(dbConfig.parse(provider))
 * // { host: "localhost", port: 5432 }
 * ```
 *
 * @since 4.0.0
 */
export function all<const Arg extends Iterable<Config<any>> | Record<string, Config<any>>>(
  arg: Arg
): Config<
  [Arg] extends [ReadonlyArray<Config<any>>] ? {
      -readonly [K in keyof Arg]: [Arg[K]] extends [Config<infer A>] ? A : never
    }
    : [Arg] extends [Iterable<Config<infer A>>] ? Array<A>
    : [Arg] extends [Record<string, Config<any>>] ? {
        -readonly [K in keyof Arg]: [Arg[K]] extends [Config<infer A>] ? A : never
      }
    : never
> {
  const configs: Array<Config<any>> | Record<string, Config<any>> = Array.isArray(arg)
    ? arg
    : Symbol.iterator in arg
    ? [...arg as any]
    : arg
  if (Array.isArray(configs)) {
    return make((provider) => Effect.all(configs.map((config) => config.parse(provider)))) as any
  } else {
    return make((provider) => Effect.all(Rec.map(configs, (config) => config.parse(provider)))) as any
  }
}

function isMissingDataOnly(issue: Issue.Issue): boolean {
  switch (issue._tag) {
    case "MissingKey":
      return true
    case "InvalidType":
    case "InvalidValue":
      return Option.isNone(issue.actual) || (Option.isSome(issue.actual) && issue.actual.value === undefined)
    case "OneOf":
      return issue.actual === undefined
    case "Encoding":
      return Option.isNone(issue.actual) || (Option.isSome(issue.actual) && issue.actual.value === undefined)
        ? true
        : isMissingDataOnly(issue.issue)
    case "Pointer":
    case "Filter":
      return isMissingDataOnly(issue.issue)
    case "UnexpectedKey":
      return false
    case "Forbidden":
      return false
    case "Composite":
    case "AnyOf":
      return issue.issues.every(isMissingDataOnly)
  }
}

/**
 * Provides a fallback value when the config fails due to missing data.
 *
 * When to use:
 * - Making a config key optional with a sensible default.
 *
 * Only applies when the error is a `SchemaError` caused exclusively by
 * missing data (missing keys, undefined values). Validation errors (wrong
 * type, out of range) still propagate. The default is lazily evaluated.
 *
 * Supports both data-last and data-first calling conventions.
 *
 * **Example** (Defaulting a missing port)
 *
 * ```ts
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const port = Config.number("port").pipe(Config.withDefault(3000))
 *
 * const provider = ConfigProvider.fromUnknown({})
 * // Effect.runSync(port.parse(provider)) // 3000
 * ```
 *
 * @see {@link option} – returns `Option` instead of a default value
 * @see {@link orElse} – catches all errors, not just missing data
 *
 * @since 4.0.0
 */
export const withDefault: {
  <const A2>(defaultValue: A2): <A>(self: Config<A>) => Config<A2 | A>
  <A, const A2>(self: Config<A>, defaultValue: A2): Config<A | A2>
} = dual(2, <A, const A2>(self: Config<A>, defaultValue: A2): Config<A | A2> => {
  return orElse(self, (err) => {
    if (Schema.isSchemaError(err.cause)) {
      const issue = err.cause.issue
      if (isMissingDataOnly(issue)) {
        return succeed(defaultValue)
      }
    }
    return fail(err.cause)
  })
})

/**
 * Makes a config optional: returns `Some(value)` on success and `None` when
 * data is missing.
 *
 * When to use:
 * - A config key may or may not be present and you want to handle both
 *   cases explicitly.
 *
 * Like {@link withDefault}, only missing-data errors produce `None`.
 * Validation errors still propagate.
 *
 * **Example** (Optional config)
 *
 * ```ts
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const maybePort = Config.option(Config.number("port"))
 *
 * const provider = ConfigProvider.fromUnknown({})
 * // Effect.runSync(maybePort.parse(provider)) // { _tag: "None" }
 * ```
 *
 * @see {@link withDefault} – provide a concrete fallback value instead
 *
 * @since 4.0.0
 */
export const option = <A>(self: Config<A>): Config<Option.Option<A>> =>
  self.pipe(map(Option.some), withDefault(Option.none()))

/**
 * @since 3.0.0
 */
export type Success<T> = [T] extends [Config<infer A>] ? A : never

/**
 * Utility type that recursively replaces primitives with `Config` in a nested
 * structure.
 *
 * `Config.Wrap<{ key: string }>` becomes `{ key: Config<string> } | Config<{ key: string }>`
 *
 * When to use:
 * - Typing the input of {@link unwrap} so callers can pass either a `Config`
 *   or a record of `Config`s.
 *
 * @see {@link unwrap} – construct a `Config` from a `Wrap<T>`
 *
 * @category Wrap
 * @since 4.0.0
 */
export type Wrap<A> = [NonNullable<A>] extends [infer T] ? [IsPlainObject<T>] extends [true] ?
      | { readonly [K in keyof A]: Wrap<A[K]> }
      | Config<A>
  : Config<A>
  : Config<A>

type IsPlainObject<A> = [A] extends [Record<string, any>]
  ? [keyof A] extends [never] ? false : [keyof A] extends [string] ? true : false
  : false

/**
 * Constructs a `Config<T>` from a value matching `Wrap<T>`.
 *
 * When to use:
 * - Accepting config from callers who may pass either a single `Config` or a
 *   record of individual `Config`s.
 *
 * If the input is already a `Config`, it is returned as-is. Otherwise, each
 * key is recursively unwrapped and combined.
 *
 * **Example** (Unwrapping a record of configs)
 *
 * ```ts
 * import { Config } from "effect"
 *
 * interface Options {
 *   key: string
 * }
 *
 * const makeConfig = (config: Config.Wrap<Options>): Config.Config<Options> =>
 *   Config.unwrap(config)
 * ```
 *
 * @see {@link Wrap} – the utility type accepted by this function
 *
 * @category Wrap
 * @since 4.0.0
 */
export const unwrap = <T>(wrapped: Wrap<T>): Config<T> => {
  if (isConfig(wrapped)) return wrapped
  return make((provider) => {
    const entries = Object.entries(wrapped)
    const configs = entries.map(([key, config]) =>
      unwrap(config as any).parse(provider).pipe(Effect.map((value) => [key, value] as const))
    )
    return Effect.all(configs).pipe(Effect.map(Object.fromEntries))
  })
}

// -----------------------------------------------------------------------------
// schema
// -----------------------------------------------------------------------------

const dump: (
  provider: ConfigProvider.ConfigProvider,
  path: Path
) => Effect.Effect<Schema.StringTree, SourceError> = Effect.fnUntraced(function*(
  provider,
  path
) {
  const stat = yield* provider.load(path)
  if (stat === undefined) return undefined
  switch (stat._tag) {
    case "Value":
      return stat.value
    case "Record": {
      if (stat.value !== undefined) return stat.value
      const out: Record<string, Schema.StringTree> = {}
      for (const key of stat.keys) {
        const child = yield* dump(provider, [...path, key])
        if (child !== undefined) out[key] = child
      }
      return out
    }
    case "Array": {
      if (stat.value !== undefined) return stat.value
      const out: Array<Schema.StringTree> = []
      for (let i = 0; i < stat.length; i++) {
        out.push(yield* dump(provider, [...path, i]))
      }
      return out
    }
  }
})

const recur: (
  ast: AST.AST,
  provider: ConfigProvider.ConfigProvider,
  path: Path
) => Effect.Effect<Schema.StringTree, Schema.SchemaError | SourceError> = Effect.fnUntraced(
  function*(ast, provider, path) {
    switch (ast._tag) {
      case "Objects": {
        const out: Record<string, Schema.StringTree> = {}
        for (const ps of ast.propertySignatures) {
          const name = ps.name
          if (typeof name === "string") {
            const value = yield* recur(ps.type, provider, [...path, name])
            if (value !== undefined) out[name] = value
          }
        }
        if (ast.indexSignatures.length > 0) {
          const stat = yield* provider.load(path)
          if (stat && stat._tag === "Record") {
            for (const is of ast.indexSignatures) {
              const matches = Parser._is(is.parameter)
              for (const key of stat.keys) {
                if (!Object.hasOwn(out, key) && matches(key)) {
                  const value = yield* recur(is.type, provider, [...path, key])
                  if (value !== undefined) out[key] = value
                }
              }
            }
          }
        }
        return out
      }
      case "Arrays": {
        const stat = yield* provider.load(path)
        if (stat && stat._tag === "Value") return stat.value
        const out: Array<Schema.StringTree> = []
        for (let i = 0; i < ast.elements.length; i++) {
          out.push(yield* recur(ast.elements[i], provider, [...path, i]))
        }
        return out
      }
      case "Union":
        // Let downstream decoding decide; dump can return a string, object, or array.
        return yield* dump(provider, path)
      case "Suspend":
        return yield* recur(ast.thunk(), provider, path)
      default: {
        // Base primitives / string-like encoded nodes.
        const stat = yield* provider.load(path)
        if (stat === undefined) return undefined
        if (stat._tag === "Value") return stat.value
        if (stat._tag === "Record" && stat.value !== undefined) return stat.value
        if (stat._tag === "Array" && stat.value !== undefined) return stat.value
        // Container without a co-located value cannot satisfy a scalar request.
        return undefined
      }
    }
  }
)

/**
 * Creates a `Config<T>` from a `Schema.Codec`.
 *
 * When to use:
 * - Reading structured or validated config (structs, arrays, unions, branded
 *   types, etc.).
 * - All convenience constructors (`string`, `number`, …) delegate to this.
 *
 * The optional `path` sets the root path segment(s) for the config lookup.
 * Pass a single string for a flat key or an array for nested paths.
 *
 * The codec is used to decode the raw `StringTree` produced by the provider
 * into `T`. Schema validation errors are wrapped in `ConfigError`.
 *
 * **Example** (Reading a structured config)
 *
 * ```ts
 * import { Config, ConfigProvider, Effect, Schema } from "effect"
 *
 * const DbConfig = Config.schema(
 *   Schema.Struct({
 *     host: Schema.String,
 *     port: Schema.Int
 *   }),
 *   "db"
 * )
 *
 * const provider = ConfigProvider.fromUnknown({
 *   db: { host: "localhost", port: 5432 }
 * })
 *
 * // Effect.runSync(DbConfig.parse(provider))
 * // { host: "localhost", port: 5432 }
 * ```
 *
 * @see {@link string} / {@link number} / {@link boolean} – shortcuts for
 *   single-value configs
 *
 * @category Schema
 * @since 4.0.0
 */
export function schema<T, E>(codec: Schema.Codec<T, E>, path?: string | ConfigProvider.Path): Config<T> {
  const codecStringTree = Schema.toCodecStringTree(codec)
  const decodeUnknownEffect = Parser.decodeUnknownEffect(codecStringTree)
  const codecStringTreeEncoded = AST.toEncoded(codecStringTree.ast)
  const defaultPath = typeof path === "string" ? [path] : path ?? []
  return make((provider) => {
    const path = provider.prefix ? [...provider.prefix, ...defaultPath] : defaultPath
    return recur(codecStringTreeEncoded, provider, defaultPath).pipe(
      Effect.flatMapEager((tree) =>
        decodeUnknownEffect(tree).pipe(
          Effect.mapErrorEager((issue) =>
            new Schema.SchemaError(path.length > 0 ? new Issue.Pointer(path, issue) : issue)
          )
        )
      ),
      Effect.mapErrorEager((cause) => new ConfigError(cause))
    )
  })
}

/** @internal */
export const TrueValues = Schema.Literals(["true", "yes", "on", "1", "y"])

/** @internal */
export const FalseValues = Schema.Literals(["false", "no", "off", "0", "n"])

/**
 * A `Schema.Codec` for boolean values encoded as strings.
 *
 * When to use:
 * - Pass to {@link schema} for custom paths, or use the {@link boolean}
 *   convenience constructor.
 *
 * Accepted string values: `true`, `false`, `yes`, `no`, `on`, `off`, `1`,
 * `0`, `y`, `n` (case-sensitive).
 *
 * @see {@link boolean} – convenience constructor
 *
 * @category Schema
 * @since 4.0.0
 */
export const Boolean = Schema.Literals([...TrueValues.literals, ...FalseValues.literals]).pipe(
  Schema.decodeTo(
    Schema.Boolean,
    Transformation.transform({
      decode: (value) => value === "true" || value === "yes" || value === "on" || value === "1" || value === "y",
      encode: (value) => value ? "true" : "false"
    })
  )
)

/**
 * A `Schema.Codec` for `Duration` values encoded as strings.
 *
 * When to use:
 * - Pass to {@link schema} for custom paths, or use the {@link duration}
 *   convenience constructor.
 *
 * Accepts any string that `Duration.fromInput` can parse (e.g.
 * `"10 seconds"`, `"500 millis"`).
 *
 * @see {@link duration} – convenience constructor
 *
 * @category Schema
 * @since 4.0.0
 */
export const Duration = Schema.String.pipe(Schema.decodeTo(Schema.Duration, {
  decode: Getter.transformOrFail((s) => {
    const d = Duration_.fromInput(s as any)
    return Option.match(d, {
      onNone: () => Effect.fail(new Issue.InvalidValue(Option.some(s))),
      onSome: Effect.succeed
    })
  }),
  encode: Getter.forbidden(() => "Encoding Duration is not supported")
}))

/**
 * A `Schema.Codec` for port numbers (integers in 1–65535).
 *
 * When to use:
 * - Pass to {@link schema} for custom paths, or use the {@link port}
 *   convenience constructor.
 *
 * @see {@link port} – convenience constructor
 *
 * @category Schema
 * @since 4.0.0
 */
export const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))

/**
 * A `Schema.Codec` for `LogLevel` string literals.
 *
 * When to use:
 * - Pass to {@link schema} for custom paths, or use the {@link logLevel}
 *   convenience constructor.
 *
 * Accepted values: `"All"`, `"Fatal"`, `"Error"`, `"Warn"`, `"Info"`,
 * `"Debug"`, `"Trace"`, `"None"`.
 *
 * @see {@link logLevel} – convenience constructor
 *
 * @category Schema
 * @since 4.0.0
 */
export const LogLevel = Schema.Literals(LogLevel_.values)

/**
 * A `Schema.Codec` for key-value record types that can also be parsed from
 * a flat comma-separated string.
 *
 * When to use:
 * - Reading key-value maps from a single env var (e.g. OpenTelemetry
 *   resource attributes).
 *
 * Accepts either a JSON-like record from the provider or a flat string like
 * `"key1=val1,key2=val2"`. The `separator` (default `","`) and
 * `keyValueSeparator` (default `"="`) can be customized.
 *
 * **Example** (Parsing a comma-separated record)
 *
 * ```ts
 * import { Config, ConfigProvider, Effect, Schema } from "effect"
 *
 * const schema = Config.Record(Schema.String, Schema.String)
 * const config = Config.schema(schema, "OTEL_RESOURCE_ATTRIBUTES")
 *
 * const provider = ConfigProvider.fromEnv({
 *   env: {
 *     OTEL_RESOURCE_ATTRIBUTES:
 *       "service.name=my-service,service.version=1.0.0,custom.attribute=value"
 *   }
 * })
 *
 * console.dir(Effect.runSync(config.parse(provider)))
 * // {
 * //   'service.name': 'my-service',
 * //   'service.version': '1.0.0',
 * //   'custom.attribute': 'value'
 * // }
 * ```
 *
 * @category Schemas
 * @since 4.0.0
 */
export const Record = <K extends Schema.Record.Key, V extends Schema.Top>(key: K, value: V, options?: {
  readonly separator?: string | undefined
  readonly keyValueSeparator?: string | undefined
}) => {
  const record = Schema.Record(key, value)
  const recordString = Schema.String.pipe(
    Schema.decodeTo(
      Schema.Record(Schema.String, Schema.String),
      Transformation.splitKeyValue(options)
    ),
    Schema.decodeTo(record)
  )

  return Schema.Union([record, recordString])
}

// -----------------------------------------------------------------------------
// constructors
// -----------------------------------------------------------------------------

/**
 * Creates a config that always fails with the given error.
 *
 * When to use:
 * - Inside {@link orElse} to re-raise a specific error.
 * - Testing error handling paths.
 *
 * @category Constructors
 * @since 4.0.0
 */
export function fail(err: SourceError | Schema.SchemaError) {
  return make(() => Effect.fail(new ConfigError(err)))
}

/**
 * Creates a config that always succeeds with the given value, ignoring the
 * provider entirely.
 *
 * When to use:
 * - Providing a hardcoded constant inside {@link orElse}.
 * - Testing.
 *
 * **Example** (Constant fallback)
 *
 * ```ts
 * import { Config } from "effect"
 *
 * const host = Config.string("HOST").pipe(
 *   Config.orElse(() => Config.succeed("localhost"))
 * )
 * ```
 *
 * @category Constructors
 * @since 4.0.0
 */
export function succeed<T>(value: T) {
  return make(() => Effect.succeed(value))
}

/**
 * Creates a config for a single string value.
 *
 * Shortcut for `Config.schema(Schema.String, name)`.
 *
 * When to use:
 * - Reading a single string env var or config key.
 *
 * **Example** (Reading a string config)
 *
 * ```ts
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const host = Config.string("HOST")
 *
 * const provider = ConfigProvider.fromUnknown({ HOST: "localhost" })
 * // Effect.runSync(host.parse(provider)) // "localhost"
 * ```
 *
 * @see {@link nonEmptyString} – rejects empty strings
 * @see {@link schema} – for more complex types
 *
 * @category Constructors
 * @since 4.0.0
 */
export function string(name?: string) {
  return schema(Schema.String, name)
}

/**
 * Creates a config for a non-empty string value. Fails if the value is an
 * empty string.
 *
 * Shortcut for `Config.schema(Schema.NonEmptyString, name)`.
 *
 * @see {@link string} – allows empty strings
 *
 * @category Constructors
 * @since 4.0.0
 */
export function nonEmptyString(name?: string) {
  return schema(Schema.NonEmptyString, name)
}

/**
 * Creates a config for a numeric value (including `NaN`, `Infinity`).
 *
 * Shortcut for `Config.schema(Schema.Number, name)`.
 *
 * @see {@link finite} – rejects `NaN` and `Infinity`
 * @see {@link int} – only integers
 *
 * @category Constructors
 * @since 4.0.0
 */
export function number(name?: string) {
  return schema(Schema.Number, name)
}

/**
 * Creates a config for a finite number (rejects `NaN` and `Infinity`).
 *
 * Shortcut for `Config.schema(Schema.Finite, name)`.
 *
 * @see {@link number} – allows `NaN` and `Infinity`
 * @see {@link int} – only integers
 *
 * @category Constructors
 * @since 4.0.0
 */
export function finite(name?: string) {
  return schema(Schema.Finite, name)
}

/**
 * Creates a config for an integer value. Rejects floats.
 *
 * Shortcut for `Config.schema(Schema.Int, name)`.
 *
 * @see {@link number} – allows any number
 * @see {@link port} – integers in 1–65535
 *
 * @category Constructors
 * @since 4.0.0
 */
export function int(name?: string) {
  return schema(Schema.Int, name)
}

/**
 * Creates a config that only accepts a specific literal value.
 *
 * Shortcut for `Config.schema(Schema.Literal(literal), name)`.
 *
 * **Example** (Restricting to a literal)
 *
 * ```ts
 * import { Config } from "effect"
 *
 * const env = Config.literal("production", "ENV")
 * ```
 *
 * @category Constructors
 * @since 4.0.0
 */
export function literal<L extends AST.LiteralValue>(literal: L, name?: string) {
  return schema(Schema.Literal(literal), name)
}

/**
 * Creates a config for a boolean value parsed from common string
 * representations.
 *
 * Shortcut for `Config.schema(Config.Boolean, name)`.
 *
 * Accepted values: `true`, `false`, `yes`, `no`, `on`, `off`, `1`, `0`,
 * `y`, `n`.
 *
 * **Example** (Reading a boolean flag)
 *
 * ```ts
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const flag = yield* Config.boolean("FEATURE_FLAG")
 *   console.log(flag)
 * })
 *
 * const provider = ConfigProvider.fromEnv({
 *   env: {
 *     FEATURE_FLAG: "yes"
 *   }
 * })
 *
 * Effect.runSync(
 *   program.pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider))
 * )
 * // Output: true
 * ```
 *
 * @category Constructors
 * @since 4.0.0
 */
export function boolean(name?: string) {
  return schema(Boolean, name)
}

/**
 * Creates a config for a `Duration` value parsed from a human-readable
 * string.
 *
 * Shortcut for `Config.schema(Config.Duration, name)`.
 *
 * Accepts any string that `Duration.fromInput` can parse (e.g.
 * `"10 seconds"`, `"500 millis"`, `"2 minutes"`).
 *
 * **Example** (Reading a duration)
 *
 * ```ts
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const duration = yield* Config.duration("DURATION")
 *   console.log(duration)
 * })
 *
 * const provider = ConfigProvider.fromEnv({
 *   env: {
 *     DURATION: "10 seconds"
 *   }
 * })
 *
 * Effect.runSync(
 *   program.pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider))
 * )
 * // Output: Duration { _tag: "millis", value: 10000 }
 * ```
 *
 * @category Constructors
 * @since 4.0.0
 */
export function duration(name?: string) {
  return schema(Duration, name)
}

/**
 * Creates a config for a port number (integer in 1–65535).
 *
 * Shortcut for `Config.schema(Config.Port, name)`.
 *
 * **Example** (Reading a port)
 *
 * ```ts
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const port = yield* Config.port("PORT")
 *   console.log(port)
 * })
 *
 * const provider = ConfigProvider.fromEnv({
 *   env: {
 *     PORT: "8080"
 *   }
 * })
 *
 * Effect.runSync(
 *   program.pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider))
 * )
 * // Output: 8080
 * ```
 *
 * @category Constructors
 * @since 4.0.0
 */
export function port(name?: string) {
  return schema(Port, name)
}

/**
 * Creates a config for a log level string.
 *
 * Shortcut for `Config.schema(Config.LogLevel, name)`.
 *
 * Accepted values: `"All"`, `"Fatal"`, `"Error"`, `"Warn"`, `"Info"`,
 * `"Debug"`, `"Trace"`, `"None"`.
 *
 * **Example** (Reading a log level)
 *
 * ```ts
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const logLevel = yield* Config.logLevel("LOG_LEVEL")
 *   console.log(logLevel)
 * })
 *
 * const provider = ConfigProvider.fromEnv({
 *   env: {
 *     LOG_LEVEL: "Info"
 *   }
 * })
 *
 * Effect.runSync(
 *   program.pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider))
 * )
 * // Output: "Info"
 * ```
 *
 * @category Constructors
 * @since 4.0.0
 */
export function logLevel(name?: string) {
  return schema(LogLevel, name)
}

/**
 * Creates a config for a redacted string value. The parsed result is wrapped
 * in a `Redacted` container that hides the value from logs and `toString`.
 *
 * Shortcut for `Config.schema(Schema.Redacted(Schema.String), name)`.
 *
 * **Example** (Reading a secret)
 *
 * ```ts
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const apiKey = yield* Config.redacted("API_KEY")
 *   console.log(apiKey)
 * })
 *
 * const provider = ConfigProvider.fromEnv({
 *   env: {
 *     API_KEY: "sk-1234567890abcdef"
 *   }
 * })
 *
 * Effect.runSync(
 *   program.pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider))
 * )
 * // Output: <redacted>
 * ```
 *
 * @category Constructors
 * @since 4.0.0
 */
export function redacted(name?: string) {
  return schema(Schema.Redacted(Schema.String), name)
}

/**
 * Creates a config for a `URL` value parsed from a string.
 *
 * Fails if the string cannot be parsed by the `URL` constructor.
 *
 * **Example** (Reading a URL)
 *
 * ```ts
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const url = yield* Config.url("URL")
 *   console.log(url)
 * })
 *
 * const provider = ConfigProvider.fromEnv({
 *   env: {
 *     URL: "https://example.com"
 *   }
 * })
 *
 * Effect.runSync(
 *   program.pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider))
 * )
 * // Output:
 * // URL {
 * //   href: 'https://example.com/',
 * //   origin: 'https://example.com',
 * //   protocol: 'https:',
 * //   username: '',
 * //   password: '',
 * //   host: 'example.com',
 * //   hostname: 'example.com',
 * //   port: '',
 * //   pathname: '/',
 * //   search: '',
 * //   searchParams: URLSearchParams {},
 * //   hash: ''
 * // }
 * ```
 *
 * @category Constructors
 * @since 4.0.0
 */
export function url(name?: string) {
  return schema(Schema.URL, name)
}

/**
 * Creates a config for a `Date` value parsed from a string.
 *
 * Fails with a `SchemaError` if the string produces an invalid `Date`.
 *
 * Shortcut for `Config.schema(Schema.DateValid, name)`.
 *
 * **Example** (Reading a date)
 *
 * ```ts
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const createdAt = Config.date("CREATED_AT")
 *
 * const provider = ConfigProvider.fromUnknown({ CREATED_AT: "2024-01-15" })
 * // Effect.runSync(createdAt.parse(provider))
 * // Date("2024-01-15T00:00:00.000Z")
 * ```
 *
 * @category Constructors
 * @since 4.0.0
 */
export function date(name?: string) {
  return schema(Schema.DateValid, name)
}

/**
 * Scopes a config under a named prefix.
 *
 * When to use:
 * - Grouping related config keys under a common namespace (e.g.
 *   `"database"`, `"redis"`).
 * - Building reusable config fragments that callers nest at different paths.
 *
 * The prefix is prepended to every key the inner config reads. With
 * `fromUnknown` this means an extra object level; with `fromEnv` it means
 * a `_`-separated prefix on env var names.
 *
 * Multiple `nested` calls compose: the outermost name becomes the
 * outermost path segment.
 *
 * **Example** (Nesting a struct config under `"database"`)
 *
 * ```ts
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const dbConfig = Config.all({
 *   host: Config.string("host"),
 *   port: Config.number("port")
 * }).pipe(Config.nested("database"))
 *
 * const provider = ConfigProvider.fromUnknown({
 *   database: { host: "localhost", port: "5432" }
 * })
 * // Effect.runSync(dbConfig.parse(provider))
 * // { host: "localhost", port: 5432 }
 * ```
 *
 * **Example** (Env vars with nested prefix)
 *
 * ```ts
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const host = Config.string("host").pipe(Config.nested("database"))
 *
 * const provider = ConfigProvider.fromEnv({
 *   env: { database_host: "localhost" }
 * })
 * // Effect.runSync(host.parse(provider)) // "localhost"
 * ```
 *
 * @see {@link all} – combine multiple configs into a struct
 * @see {@link schema} – read structured config from a schema
 *
 * @category Combinators
 * @since 4.0.0
 */
export const nested: {
  (name: string): <A>(self: Config<A>) => Config<A>
  <A>(self: Config<A>, name: string): Config<A>
} = dual(
  2,
  <A>(self: Config<A>, name: string): Config<A> => make((provider) => self.parse(ConfigProvider.nested(provider, name)))
)
