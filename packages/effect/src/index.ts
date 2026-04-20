/**
 * @since 2.0.0
 */

export {
  /**
   * @since 2.0.0
   */
  absurd,
  /**
   * @since 2.0.0
   */
  cast,
  /**
   * @since 2.0.0
   */
  flow,
  /**
   * @since 2.0.0
   */
  hole,
  /**
   * @since 2.0.0
   */
  identity,
  /**
   * @since 2.0.0
   */
  pipe
} from "./Function.ts"

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * Utilities for working with immutable arrays (and non-empty arrays) in a
 * functional style. All functions treat arrays as immutable — they return new
 * arrays rather than mutating the input.
 *
 * ## Mental model
 *
 * - **`Array<A>`** is a standard JS array. All functions in this module return
 *   new arrays; the input is never mutated.
 * - **`NonEmptyReadonlyArray<A>`** (`readonly [A, ...Array<A>]`) is a readonly
 *   array guaranteed to have at least one element. Many functions preserve or
 *   require this guarantee at the type level.
 * - **`NonEmptyArray<A>`** is the mutable counterpart: `[A, ...Array<A>]`.
 * - Most functions are **dual** — they can be called either as
 *   `Array.fn(array, arg)` (data-first) or piped as
 *   `pipe(array, Array.fn(arg))` (data-last).
 * - Functions that access elements by index return `Option<A>` for safety; use
 *   the `*NonEmpty` variants (e.g. {@link headNonEmpty}) when you already know
 *   the array is non-empty.
 * - Set-like operations ({@link union}, {@link intersection},
 *   {@link difference}) use `Equal.equivalence()` by default; use the `*With`
 *   variants for custom equality.
 *
 * ## Common tasks
 *
 * - **Create** an array: {@link make}, {@link of}, {@link empty},
 *   {@link fromIterable}, {@link range}, {@link makeBy}, {@link replicate},
 *   {@link unfold}
 * - **Access** elements: {@link head}, {@link last}, {@link get}, {@link tail},
 *   {@link init}
 * - **Transform**: {@link map}, {@link flatMap}, {@link flatten}
 * - **Filter**: {@link filter}, {@link partition}, {@link dedupe}
 * - **Combine**: {@link append}, {@link prepend}, {@link appendAll},
 *   {@link prependAll}, {@link zip}, {@link cartesian}
 * - **Split**: {@link splitAt}, {@link chunksOf}, {@link span}, {@link window}
 * - **Search**: {@link findFirst}, {@link findLast}, {@link contains}
 * - **Sort**: {@link sort}, {@link sortBy}, {@link sortWith}
 * - **Fold**: {@link reduce}, {@link scan}, {@link join}
 * - **Group**: {@link groupBy}, {@link group}, {@link groupWith}
 * - **Set operations**: {@link union}, {@link intersection},
 *   {@link difference}
 * - **Match** on empty vs non-empty: {@link match}, {@link matchLeft},
 *   {@link matchRight}
 * - **Check** properties: {@link isArray}, {@link isArrayNonEmpty},
 *   {@link every}, {@link some}
 *
 * ## Gotchas
 *
 * - {@link fromIterable} returns the original array reference when given an
 *   array; if you need a copy, use {@link copy}.
 * - `sort`, `reverse`, etc. always allocate a new array — the input is never
 *   mutated.
 * - {@link makeBy} and {@link replicate} normalize `n` to an integer >= 1 —
 *   they never produce an empty array.
 * - {@link range}`(start, end)` is inclusive on both ends. If `start > end` it
 *   returns `[start]`.
 * - Functions returning `Option` (e.g. {@link head}, {@link findFirst}) return
 *   `Option.none()` for empty inputs — they never throw.
 *
 * ## Quickstart
 *
 * **Example** (Basic array operations)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const numbers = Array.make(1, 2, 3, 4, 5)
 *
 * const doubled = Array.map(numbers, (n) => n * 2)
 * console.log(doubled) // [2, 4, 6, 8, 10]
 *
 * const evens = Array.filter(numbers, (n) => n % 2 === 0)
 * console.log(evens) // [2, 4]
 *
 * const sum = Array.reduce(numbers, 0, (acc, n) => acc + n)
 * console.log(sum) // 15
 * ```
 *
 * @see {@link make} — create a non-empty array from elements
 * @see {@link map} — transform each element
 * @see {@link filter} — keep elements matching a predicate
 * @see {@link reduce} — fold an array to a single value
 *
 * @since 2.0.0
 */
export * as Array from "./Array.ts"

/**
 * This module provides utility functions and type class instances for working with the `BigDecimal` type in TypeScript.
 * It includes functions for basic arithmetic operations.
 *
 * A `BigDecimal` allows storing any real number to arbitrary precision; which avoids common floating point errors
 * (such as 0.1 + 0.2 ≠ 0.3) at the cost of complexity.
 *
 * Internally, `BigDecimal` uses a `BigInt` object, paired with a 64-bit integer which determines the position of the
 * decimal point. Therefore, the precision *is not* actually arbitrary, but limited to 2<sup>63</sup> decimal places.
 *
 * It is not recommended to convert a floating point number to a decimal directly, as the floating point representation
 * may be unexpected.
 *
 * @since 2.0.0
 */
export * as BigDecimal from "./BigDecimal.ts"

/**
 * This module provides utility functions and type class instances for working with the `bigint` type in TypeScript.
 * It includes functions for basic arithmetic operations.
 *
 * @since 2.0.0
 */
export * as BigInt from "./BigInt.ts"

/**
 * This module provides utility functions and type class instances for working with the `boolean` type in TypeScript.
 * It includes functions for basic boolean operations.
 *
 * @since 2.0.0
 */
export * as Boolean from "./Boolean.ts"

/**
 * This module provides types and utility functions to create and work with
 * branded types, which are TypeScript types with an added type tag to prevent
 * accidental usage of a value in the wrong context.
 *
 * @since 2.0.0
 */
export * as Brand from "./Brand.ts"

/**
 * @since 4.0.0
 */
export * as Cache from "./Cache.ts"

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
export * as Cause from "./Cause.ts"

/**
 * The `Channel` module provides a powerful abstraction for bi-directional communication
 * and streaming operations. A `Channel` is a nexus of I/O operations that supports both
 * reading and writing, forming the foundation for Effect's Stream and Sink abstractions.
 *
 * ## What is a Channel?
 *
 * A `Channel<OutElem, OutErr, OutDone, InElem, InErr, InDone, Env>` represents:
 * - **OutElem**: The type of elements the channel outputs
 * - **OutErr**: The type of errors the channel can produce
 * - **OutDone**: The type of the final value when the channel completes
 * - **InElem**: The type of elements the channel reads
 * - **InErr**: The type of errors the channel can receive
 * - **InDone**: The type of the final value from upstream
 * - **Env**: The environment/context required by the channel
 *
 * ## Key Features
 *
 * - **Bi-directional**: Channels can both read and write
 * - **Composable**: Channels can be piped, sequenced, and concatenated
 * - **Resource-safe**: Automatic cleanup and resource management
 * - **Error-handling**: Built-in error propagation and handling
 * - **Concurrent**: Support for concurrent operations
 *
 * ## Composition Patterns
 *
 * 1. **Piping**: Connect channels where output of one becomes input of another
 * 2. **Sequencing**: Use the result of one channel to create another
 * 3. **Concatenating**: Combine multiple channels into a single channel
 *
 * @example
 * ```ts
 * import { Channel } from "effect"
 *
 * // Simple channel that outputs numbers
 * const numberChannel = Channel.succeed(42)
 *
 * // Transform channel that doubles values
 * const doubleChannel = Channel.map(numberChannel, (n) => n * 2)
 *
 * // Running the channel would output: 84
 * ```
 *
 * @example
 * ```ts
 * import { Channel } from "effect"
 *
 * // Channel from an array of values
 * const arrayChannel = Channel.fromArray([1, 2, 3, 4, 5])
 *
 * // Transform the channel by mapping over values
 * const transformedChannel = Channel.map(arrayChannel, (n) => n * 2)
 *
 * // This channel will output: 2, 4, 6, 8, 10
 * ```
 *
 * @since 2.0.0
 */
export * as Channel from "./Channel.ts"

/**
 * @since 4.0.0
 */
export * as ChannelSchema from "./ChannelSchema.ts"

/**
 * The `Chunk` module provides an immutable, high-performance sequence data structure
 * optimized for functional programming patterns. A `Chunk` is a persistent data structure
 * that supports efficient append, prepend, and concatenation operations.
 *
 * ## What is a Chunk?
 *
 * A `Chunk<A>` is an immutable sequence of elements of type `A` that provides:
 * - **O(1) append and prepend operations**
 * - **Efficient concatenation** through tree-like structure
 * - **Memory efficiency** with structural sharing
 * - **Rich API** with functional programming operations
 * - **Type safety** with full TypeScript integration
 *
 * ## Key Features
 *
 * - **Immutable**: All operations return new chunks without modifying the original
 * - **Efficient**: Optimized data structure with logarithmic complexity for most operations
 * - **Functional**: Rich set of transformation and combination operators
 * - **Lazy evaluation**: Many operations are deferred until needed
 * - **Interoperable**: Easy conversion to/from arrays and other collections
 *
 * ## Performance Characteristics
 *
 * - **Append/Prepend**: O(1) amortized
 * - **Random Access**: O(log n)
 * - **Concatenation**: O(log min(m, n))
 * - **Iteration**: O(n)
 * - **Memory**: Structural sharing minimizes allocation
 *
 * @example
 * ```ts
 * import { Chunk } from "effect"
 *
 * // Creating chunks
 * const chunk1 = Chunk.fromIterable([1, 2, 3])
 * const chunk2 = Chunk.fromIterable([4, 5, 6])
 * const empty = Chunk.empty<number>()
 *
 * // Combining chunks
 * const combined = Chunk.appendAll(chunk1, chunk2)
 * console.log(Chunk.toReadonlyArray(combined)) // [1, 2, 3, 4, 5, 6]
 * ```
 *
 * @example
 * ```ts
 * import { Chunk } from "effect"
 *
 * // Functional transformations
 * const numbers = Chunk.range(1, 5) // [1, 2, 3, 4, 5]
 * const doubled = Chunk.map(numbers, (n) => n * 2) // [2, 4, 6, 8, 10]
 * const evens = Chunk.filter(doubled, (n) => n % 4 === 0) // [4, 8]
 * const sum = Chunk.reduce(evens, 0, (acc, n) => acc + n) // 12
 * ```
 *
 * @example
 * ```ts
 * import { Chunk, Effect } from "effect"
 *
 * // Working with Effects
 * const processChunk = (chunk: Chunk.Chunk<number>) =>
 *   Effect.gen(function*() {
 *     const mapped = Chunk.map(chunk, (n) => n * 2)
 *     const filtered = Chunk.filter(mapped, (n) => n > 5)
 *     return Chunk.toReadonlyArray(filtered)
 *   })
 * ```
 *
 * @since 2.0.0
 */
export * as Chunk from "./Chunk.ts"

/**
 * The `Clock` module provides functionality for time-based operations in Effect applications.
 * It offers precise time measurements, scheduling capabilities, and controlled time management
 * for testing scenarios.
 *
 * The Clock service is a core component of the Effect runtime, providing:
 * - Current time access in milliseconds and nanoseconds
 * - Sleep operations for delaying execution
 * - Time-based scheduling primitives
 * - Testable time control through `TestClock`
 *
 * ## Key Features
 *
 * - **Precise timing**: Access to both millisecond and nanosecond precision
 * - **Sleep operations**: Non-blocking sleep with proper interruption handling
 * - **Service integration**: Seamless integration with Effect's dependency injection
 * - **Testable**: Mock time control for deterministic testing
 * - **Resource-safe**: Automatic cleanup of time-based resources
 *
 * @example
 * ```ts
 * import { Clock, Effect } from "effect"
 *
 * // Get current time in milliseconds
 * const getCurrentTime = Clock.currentTimeMillis
 *
 * // Sleep for 1 second
 * const sleep1Second = Effect.sleep("1 seconds")
 *
 * // Measure execution time
 * const measureTime = Effect.gen(function*() {
 *   const start = yield* Clock.currentTimeMillis
 *   yield* Effect.sleep("100 millis")
 *   const end = yield* Clock.currentTimeMillis
 *   return end - start
 * })
 * ```
 *
 * @example
 * ```ts
 * import { Clock, Effect } from "effect"
 *
 * // Using Clock service directly
 * const program = Effect.gen(function*() {
 *   const clock = yield* Clock.Clock
 *   const currentTime = yield* clock.currentTimeMillis
 *   console.log(`Current time: ${currentTime}`)
 *
 *   // Sleep for 500ms
 *   yield* Effect.sleep("500 millis")
 *
 *   const afterSleep = yield* clock.currentTimeMillis
 *   console.log(`After sleep: ${afterSleep}`)
 * })
 * ```
 *
 * @since 2.0.0
 */
export * as Clock from "./Clock.ts"

/**
 * A module for combining two values of the same type into one.
 *
 * A `Combiner<A>` wraps a single binary function `(self: A, that: A) => A`.
 * It describes *how* two values merge but carries no initial/empty value
 * (for that, see {@link Reducer} which extends `Combiner` with an
 * `initialValue`).
 *
 * ## Mental model
 *
 * - **Combiner** – an object with a `combine(self, that)` method that returns
 *   a value of the same type.
 * - **Argument order** – `self` is the "left" / accumulator side, `that` is
 *   the "right" / incoming side.
 * - **No identity element** – unlike a monoid, a `Combiner` does not require
 *   a neutral element. Use {@link Reducer} when you need one.
 * - **Purity** – all combiners produced by this module are pure; they never
 *   mutate their arguments.
 * - **Composability** – combiners can be lifted into `Option`, `Struct`,
 *   `Tuple`, and other container types via helpers in those modules.
 *
 * ## Common tasks
 *
 * - Create a combiner from any binary function → {@link make}
 * - Swap argument order → {@link flip}
 * - Pick the smaller / larger of two values → {@link min} / {@link max}
 * - Always keep the first or last value → {@link first} / {@link last}
 * - Ignore both values and return a fixed result → {@link constant}
 * - Insert a separator between combined values → {@link intercalate}
 *
 * ## Gotchas
 *
 * - `min` and `max` require an `Order<A>`, not a raw comparator. Import from
 *   e.g. `Number.Order` or `String.Order`.
 * - `intercalate` is curried: call it with the separator first, then pass the
 *   base combiner.
 * - A `Reducer` (which adds `initialValue`) is also a valid `Combiner` — you
 *   can pass a `Reducer` anywhere a `Combiner` is expected.
 *
 * ## Quickstart
 *
 * **Example** (combining strings with a separator)
 *
 * ```ts
 * import { Combiner, String } from "effect"
 *
 * const csv = Combiner.intercalate(",")(String.ReducerConcat)
 *
 * console.log(csv.combine("a", "b"))
 * // Output: "a,b"
 *
 * console.log(csv.combine(csv.combine("a", "b"), "c"))
 * // Output: "a,b,c"
 * ```
 *
 * ## See also
 *
 * - {@link make} – the primary constructor
 * - {@link Combiner} – the core interface
 *
 * @since 4.0.0
 */
export * as Combiner from "./Combiner.ts"

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
export * as Config from "./Config.ts"

/**
 * Provides the data source layer for the `Config` module. A `ConfigProvider`
 * knows how to load raw configuration nodes from a backing store (environment
 * variables, JSON objects, `.env` files, file trees) and expose them through a
 * uniform `Node` interface that `Config` schemas consume.
 *
 * ## Mental model
 *
 * - **Node** – a discriminated union (`Value | Record | Array`) that describes
 *   what lives at a given path in the configuration tree.
 * - **Path** – an array of string or numeric segments used to address a node
 *   (e.g. `["database", "host"]`).
 * - **ConfigProvider** – an object with a `load(path)` method that resolves a
 *   path to a `Node | undefined`. Providers can be composed and transformed.
 * - **Context.Reference** – `ConfigProvider` is registered as a reference
 *   service that defaults to `fromEnv()`, so it works without explicit
 *   provision.
 * - **SourceError** – the typed error returned when a backing store is
 *   unreadable (I/O failure, permission error, etc.).
 *
 * ## Common tasks
 *
 * - Read from environment variables → {@link fromEnv}
 * - Read from a JSON / plain object → {@link fromUnknown}
 * - Parse a `.env` string → {@link fromDotEnvContents}
 * - Load a `.env` file → {@link fromDotEnv}
 * - Read from a directory tree → {@link fromDir}
 * - Build a custom provider → {@link make}
 * - Fall back to another provider → {@link orElse}
 * - Scope a provider under a prefix → {@link nested}
 * - Convert path segments to `CONSTANT_CASE` → {@link constantCase}
 * - Transform path segments arbitrarily → {@link mapInput}
 * - Install a provider as a Layer → {@link layer} / {@link layerAdd}
 *
 * ## Gotchas
 *
 * - `fromEnv` joins path segments with `_` for lookup **and** splits env var
 *   names on `_` to discover child keys. `DATABASE_HOST=x` is therefore
 *   accessible at both `["DATABASE_HOST"]` and `["DATABASE", "HOST"]`.
 * - Because of `_` splitting, querying a parent path like `["DATABASE"]`
 *   returns a `Record` node with child key `"HOST"`, even if no env var
 *   named `DATABASE` exists.
 * - When using `fromEnv` with schemas that use camelCase keys, pipe the
 *   provider through {@link constantCase} so `databaseHost` resolves to
 *   `DATABASE_HOST`.
 * - `orElse` only falls back when the primary provider returns `undefined`
 *   (path not found). It does **not** catch `SourceError`.
 * - `nested` prepends segments to the path *after* `mapInput` has run, so
 *   the order of composition matters.
 *
 * ## Quickstart
 *
 * **Example** (Reading config from environment variables)
 *
 * ```ts
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const provider = ConfigProvider.fromEnv({
 *   env: { APP_PORT: "3000", APP_HOST: "localhost" }
 * })
 *
 * const port = Config.number("port")
 *
 * const program = port.parse(
 *   provider.pipe(
 *     ConfigProvider.nested("app"),
 *     ConfigProvider.constantCase
 *   )
 * )
 *
 * // Effect.runSync(program) // 3000
 * ```
 *
 * @see {@link make} – build a provider from a lookup function
 * @see {@link fromEnv} – the default provider backed by `process.env`
 * @see {@link fromUnknown} – provider backed by a plain JS object
 *
 * @since 4.0.0
 */
export * as ConfigProvider from "./ConfigProvider.ts"

/**
 * The `Console` module provides a functional interface for console operations within
 * the Effect ecosystem. It offers type-safe logging, debugging, and console manipulation
 * capabilities with built-in support for testing and environment isolation.
 *
 * ## Key Features
 *
 * - **Type-safe logging**: All console operations return Effects for composability
 * - **Testable**: Mock console output for testing scenarios
 * - **Service-based**: Integrated with Effect's dependency injection system
 * - **Environment isolation**: Different console implementations per environment
 * - **Rich API**: Support for all standard console methods (log, error, debug, etc.)
 * - **Performance tracking**: Built-in timing and profiling capabilities
 *
 * ## Core Operations
 *
 * - **Basic logging**: `log`, `error`, `warn`, `info`, `debug`
 * - **Assertions**: `assert` for conditional logging
 * - **Grouping**: `group`, `groupCollapsed`, `groupEnd` for organized output
 * - **Timing**: `time`, `timeEnd`, `timeLog` for performance measurement
 * - **Data display**: `table`, `dir`, `dirxml` for structured data visualization
 * - **Utilities**: `clear`, `count`, `countReset`, `trace`
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * // Basic logging
 * const program = Effect.gen(function*() {
 *   yield* Console.log("Hello, World!")
 *   yield* Console.error("Something went wrong")
 *   yield* Console.warn("This is a warning")
 *   yield* Console.info("Information message")
 * })
 * ```
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * // Grouped logging with timing
 * const debugProgram = Console.withGroup(
 *   Effect.gen(function*() {
 *     yield* Console.log("Step 1: Loading...")
 *     yield* Effect.sleep("100 millis")
 *
 *     yield* Console.log("Step 2: Processing...")
 *     yield* Effect.sleep("200 millis")
 *   }),
 *   { label: "Processing Data" }
 * )
 * ```
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * // Data visualization and debugging
 * const dataProgram = Effect.gen(function*() {
 *   const users = [
 *     { id: 1, name: "Alice", age: 30 },
 *     { id: 2, name: "Bob", age: 25 }
 *   ]
 *
 *   yield* Console.table(users)
 *   yield* Console.dir(users[0], { depth: 2 })
 *   yield* Console.assert(users.length > 0, "Users array should not be empty")
 * })
 * ```
 *
 * @since 2.0.0
 */
export * as Console from "./Console.ts"

/**
 * This module provides a data structure called `Context` that can be used
 * for dependency injection in effectful programs. It is essentially a table
 * mapping `Service`s identifiers to their implementations, and can be used to
 * manage dependencies in a type-safe way. The `Context` data structure is
 * essentially a way of providing access to a set of related services that can
 * be passed around as a single unit. This module provides functions to create,
 * modify, and query the contents of a `Context`, as well as a number of
 * utility types for working with a `Context`.
 *
 * @since 4.0.0
 */
export * as Context from "./Context.ts"

/**
 * @since 2.0.0
 */
export * as Cron from "./Cron.ts"

/**
 * Immutable data constructors with discriminated-union support.
 *
 * The `Data` module provides base classes and factory functions for creating
 * immutable value types with a `_tag` field for discriminated unions.
 * It is the recommended way to define domain models, error types, and
 * lightweight ADTs in Effect applications.
 *
 * ## Mental model
 *
 * - **`Class`** — base class for plain immutable data. Extend it with a type
 *   parameter to declare the fields. Instances are `Pipeable`.
 * - **`TaggedClass`** — like `Class` but automatically adds a `readonly _tag`
 *   string literal field. Useful for single-variant types or ad-hoc tagged
 *   values.
 * - **`TaggedEnum`** (type) + **`taggedEnum`** (value) — define a multi-variant
 *   discriminated union from a simple record. `taggedEnum()` returns per-variant
 *   constructors plus `$is` / `$match` helpers.
 * - **`Error`** — like `Class` but extends `Cause.YieldableError`, so instances
 *   can be yielded inside `Effect.gen` to fail the effect.
 * - **`TaggedError`** — like `TaggedClass` but extends `Cause.YieldableError`.
 *   Works with `Effect.catchTag` for tag-based error recovery.
 *
 * ## Common tasks
 *
 * - Define a simple value class → {@link Class}
 * - Define a value class with a `_tag` → {@link TaggedClass}
 * - Define a discriminated union with constructors → {@link TaggedEnum} + {@link taggedEnum}
 * - Define a yieldable error → {@link Error}
 * - Define a yieldable tagged error → {@link TaggedError}
 * - Type-guard a tagged value → `$is` from {@link taggedEnum}
 * - Pattern-match on a tagged union → `$match` from {@link taggedEnum}
 *
 * ## Gotchas
 *
 * - Variant records passed to `TaggedEnum` must **not** contain a `_tag` key;
 *   the `_tag` is added automatically from the record key.
 * - When a class has no fields, the constructor argument is optional (`void`).
 * - `taggedEnum()` creates **plain objects**, not class instances. If you need
 *   class-based variants, use `TaggedClass` or `TaggedError` instead.
 * - `TaggedEnum.WithGenerics` supports up to 4 generic type parameters.
 *
 * ## Quickstart
 *
 * **Example** (tagged union with pattern matching)
 *
 * ```ts
 * import { Data } from "effect"
 *
 * type Shape = Data.TaggedEnum<{
 *   Circle: { readonly radius: number }
 *   Rect: { readonly width: number; readonly height: number }
 * }>
 * const { Circle, Rect, $match } = Data.taggedEnum<Shape>()
 *
 * const area = $match({
 *   Circle: ({ radius }) => Math.PI * radius ** 2,
 *   Rect: ({ width, height }) => width * height
 * })
 *
 * console.log(area(Circle({ radius: 5 })))
 * // 78.53981633974483
 * console.log(area(Rect({ width: 3, height: 4 })))
 * // 12
 * ```
 *
 * @see {@link Class} — plain immutable data class
 * @see {@link TaggedEnum} — discriminated union type
 * @see {@link taggedEnum} — discriminated union constructors
 * @see {@link TaggedError} — yieldable tagged error class
 *
 * @since 2.0.0
 */
export * as Data from "./Data.ts"

/**
 * @since 3.6.0
 */
export * as DateTime from "./DateTime.ts"

/**
 * This module provides utilities for working with `Deferred`, a powerful concurrency
 * primitive that represents an asynchronous variable that can be set exactly once.
 * Multiple fibers can await the same `Deferred` and will all be notified when it
 * completes.
 *
 * A `Deferred<A, E>` can be:
 * - **Completed successfully** with a value of type `A`
 * - **Failed** with an error of type `E`
 * - **Interrupted** if the fiber setting it is interrupted
 *
 * Key characteristics:
 * - **Single assignment**: Can only be completed once
 * - **Multiple waiters**: Many fibers can await the same `Deferred`
 * - **Fiber-safe**: Thread-safe operations across concurrent fibers
 * - **Composable**: Works seamlessly with other Effect operations
 *
 * @example
 * ```ts
 * import { Deferred, Effect, Fiber } from "effect"
 *
 * // Basic usage: coordinate between fibers
 * const program = Effect.gen(function*() {
 *   const deferred = yield* Deferred.make<string, never>()
 *
 *   // Fiber 1: waits for the value
 *   const waiter = yield* Effect.forkChild(
 *     Effect.gen(function*() {
 *       const value = yield* Deferred.await(deferred)
 *       console.log("Received:", value)
 *       return value
 *     })
 *   )
 *
 *   // Fiber 2: sets the value after a delay
 *   const setter = yield* Effect.forkChild(
 *     Effect.gen(function*() {
 *       yield* Effect.sleep("1 second")
 *       yield* Deferred.succeed(deferred, "Hello from setter!")
 *     })
 *   )
 *
 *   // Wait for both fibers
 *   yield* Fiber.join(waiter)
 *   yield* Fiber.join(setter)
 * })
 *
 * // Producer-consumer pattern
 * const producerConsumer = Effect.gen(function*() {
 *   const buffer = yield* Deferred.make<Array<number>, never>()
 *
 *   const producer = Effect.gen(function*() {
 *     const data = [1, 2, 3, 4, 5]
 *     yield* Deferred.succeed(buffer, data)
 *   })
 *
 *   const consumer = Effect.gen(function*() {
 *     const data = yield* Deferred.await(buffer)
 *     return data.reduce((sum, n) => sum + n, 0)
 *   })
 *
 *   const [, result] = yield* Effect.all([producer, consumer])
 *   return result // 15
 * })
 * ```
 *
 * @since 2.0.0
 */
export * as Deferred from "./Deferred.ts"

/**
 * @since 4.0.0
 */
export * as Differ from "./Differ.ts"

/**
 * This module provides utilities for working with durations of time. A `Duration`
 * is an immutable data type that represents a span of time with high precision,
 * supporting operations from nanoseconds to weeks.
 *
 * Durations support:
 * - **High precision**: Nanosecond-level accuracy using BigInt
 * - **Multiple formats**: Numbers (millis), BigInt (nanos), tuples, strings
 * - **Arithmetic operations**: Add, subtract, multiply, divide
 * - **Comparisons**: Equal, less than, greater than
 * - **Conversions**: Between different time units
 * - **Human-readable formatting**: Pretty printing and parsing
 *
 * @since 2.0.0
 */
export * as Duration from "./Duration.ts"

/**
 * The `Effect` module is the core of the Effect library, providing a powerful and expressive
 * way to model and compose asynchronous, concurrent, and effectful computations.
 *
 * An `Effect<A, E, R>` represents a computation that:
 * - May succeed with a value of type `A`
 * - May fail with an error of type `E`
 * - Requires a context/environment of type `R`
 *
 * Effects are lazy and immutable - they describe computations that can be executed later.
 * This allows for powerful composition, error handling, resource management, and concurrency
 * patterns.
 *
 * ## Key Features
 *
 * - **Type-safe error handling**: Errors are tracked in the type system
 * - **Resource management**: Automatic cleanup with scoped resources
 * - **Structured concurrency**: Safe parallel and concurrent execution
 * - **Composable**: Effects can be combined using operators like `flatMap`, `map`, `zip`
 * - **Testable**: Built-in support for testing with controlled environments
 * - **Interruptible**: Effects can be safely interrupted and cancelled
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * // Creating a simple effect
 * const hello = Effect.succeed("Hello, World!")
 *
 * // Composing effects
 * const program = Effect.gen(function*() {
 *   const message = yield* hello
 *   yield* Console.log(message)
 *   return message.length
 * })
 *
 * // Running the effect
 * Effect.runPromise(program).then(console.log) // 13
 * ```
 *
 * @example
 * ```ts
 * import { Data, Effect } from "effect"
 *
 * class DiscountRateError extends Data.TaggedError("DiscountRateError")<{}> {}
 *
 * // Effect that may fail
 * const divide = (a: number, b: number) =>
 *   b === 0
 *     ? Effect.fail(new DiscountRateError())
 *     : Effect.succeed(a / b)
 *
 * // Error handling
 * const program = Effect.gen(function*() {
 *   const result = yield* divide(10, 2)
 *   console.log("Result:", result) // Result: 5
 *   return result
 * })
 *
 * // Handle errors
 * const safeProgram = program.pipe(
 *   Effect.match({
 *     onFailure: (error) => -1,
 *     onSuccess: (value) => value
 *   })
 * )
 * ```
 *
 * @since 2.0.0
 */
export * as Effect from "./Effect.ts"

/**
 * @since 4.0.0
 */
export * as Effectable from "./Effectable.ts"

/**
 * Encoding & decoding for Base64 (RFC4648), Base64Url, and Hex.
 *
 * @since 4.0.0
 */
export * as Encoding from "./Encoding.ts"

/**
 * Structural and custom equality for Effect values.
 *
 * The `Equal` module provides deep structural comparison for primitives, plain
 * objects, arrays, Maps, Sets, Dates, and RegExps. Types that implement the
 * {@link Equal} interface can supply their own comparison logic while staying
 * compatible with the rest of the ecosystem (HashMap, HashSet, etc.).
 *
 * ## Mental model
 *
 * - **Structural equality** — two values are equal when their contents match,
 *   not when they share the same reference.
 * - **Hash-first shortcut** — before comparing fields, the module checks
 *   {@link Hash.hash}. If the hashes differ the objects are unequal without
 *   further traversal.
 * - **Equal interface** — any object that implements both {@link symbol} (the
 *   equality method) and `Hash.symbol` (the hash method) can define custom
 *   comparison logic.
 * - **Caching** — comparison results for object pairs are cached in a WeakMap.
 *   This makes repeated checks fast but **requires immutability** after the
 *   first comparison.
 * - **By-reference opt-out** — {@link byReference} and {@link byReferenceUnsafe}
 *   let you switch individual objects back to reference equality when you need
 *   mutable identity semantics.
 *
 * ## Common tasks
 *
 * - Compare two values → {@link equals}
 * - Check if a value implements `Equal` → {@link isEqual}
 * - Use `equals` where an `Equivalence` is expected → {@link asEquivalence}
 * - Implement custom equality on a class → implement {@link Equal} (see
 *   example on the interface)
 * - Opt an object out of structural equality → {@link byReference} /
 *   {@link byReferenceUnsafe}
 *
 * ## Gotchas
 *
 * - Objects **must be treated as immutable** after their first equality check.
 *   Results are cached; mutating an object afterwards yields stale results.
 * - `NaN` is considered equal to `NaN` (unlike `===`).
 * - Functions without an `Equal` implementation are compared by reference.
 * - Map and Set comparisons are order-independent but O(n²) in size.
 * - If only one of two objects implements `Equal`, they are never equal.
 *
 * ## Quickstart
 *
 * **Example** (basic structural comparison)
 *
 * ```ts
 * import { Equal } from "effect"
 *
 * // Primitives
 * console.log(Equal.equals(1, 1))       // true
 * console.log(Equal.equals("a", "b"))   // false
 *
 * // Objects and arrays
 * console.log(Equal.equals({ x: 1 }, { x: 1 })) // true
 * console.log(Equal.equals([1, 2], [1, 2]))       // true
 *
 * // Curried form
 * const is42 = Equal.equals(42)
 * console.log(is42(42)) // true
 * console.log(is42(0))  // false
 * ```
 *
 * @see {@link equals} — the main comparison function
 * @see {@link Equal} — the interface for custom equality
 * @see {@link Hash} — the companion hashing module
 *
 * @since 2.0.0
 */
export * as Equal from "./Equal.ts"

/**
 * Utilities for defining equivalence relations - binary relations that determine when two values
 * should be considered equivalent. Equivalence relations are used for comparing, deduplicating,
 * and organizing data in collections and data structures.
 *
 * ## Mental model
 *
 * - **Equivalence relation**: A function `(a: A, b: A) => boolean` that returns `true` when values are equivalent
 * - **Reflexive property**: Every value is equivalent to itself (`eq(a, a) === true`)
 * - **Symmetric property**: If `a` is equivalent to `b`, then `b` is equivalent to `a` (`eq(a, b) === eq(b, a)`)
 * - **Transitive property**: If `a` is equivalent to `b` and `b` is equivalent to `c`, then `a` is equivalent to `c`
 * - **Reference equality optimization**: {@link make} checks `===` first for performance before calling the custom function
 * - **Composition**: Equivalences can be combined using {@link combine} and {@link combineAll} to create more complex relations
 *
 * ## Common tasks
 *
 * - Creating custom equivalences → {@link make}
 * - Using strict equality (`===`) → {@link strictEqual}
 * - Combining multiple equivalences (AND logic) → {@link combine}, {@link combineAll}
 * - Transforming input before comparison → {@link mapInput}
 * - Creating equivalences for structured types → {@link Struct}, {@link Tuple}, {@link Array_}, {@link Record}
 *
 * ## Gotchas
 *
 * - `strictEqual` uses `===`, so `NaN !== NaN` and objects are compared by reference, not structure
 * - `make` optimizes with a reference equality check, so identical references return `true` without calling the function
 * - `combineAll` with an empty collection returns an equivalence that always returns `true`
 * - `Tuple` and `Array` require matching lengths; different lengths are never equivalent
 *
 * ## Quickstart
 *
 * **Example** (Case-insensitive string equivalence)
 *
 * ```ts
 * import { Array, Equivalence } from "effect"
 *
 * const caseInsensitive = Equivalence.make<string>((a, b) =>
 *   a.toLowerCase() === b.toLowerCase()
 * )
 *
 * const strings = ["Hello", "world", "HELLO", "World"]
 * const deduplicated = Array.dedupeWith(strings, caseInsensitive)
 * console.log(deduplicated) // ["Hello", "world"]
 * ```
 *
 * ## See also
 *
 * - {@link Equal} - For structural equality (can convert to Equivalence)
 * - {@link Array_.dedupeWith} - Remove duplicates using an equivalence
 * - {@link Chunk} - Collections that use equivalences for operations
 *
 * @since 2.0.0
 */
export * as Equivalence from "./Equivalence.ts"

/**
 * Pluggable error reporting for Effect programs.
 *
 * Reporting is triggered by `Effect.withErrorReporting`,
 * `ErrorReporter.report`, or built-in reporting boundaries in the HTTP and
 * RPC server modules.
 *
 * Each reporter receives a structured callback with the failing `Cause`, a
 * pretty-printed `Error`, severity, and any extra attributes attached to the
 * original error — making it straightforward to forward failures to Sentry,
 * Datadog, or a custom logging backend.
 *
 * Use the annotation symbols (`ignore`, `severity`, `attributes`) on your
 * error classes to control reporting behavior per-error.
 *
 * @example
 * ```ts
 * import { Data, Effect, ErrorReporter } from "effect"
 *
 * // A reporter that logs to the console
 * const consoleReporter = ErrorReporter.make(({ error, severity }) => {
 *   console.error(`[${severity}]`, error.message)
 * })
 *
 * // An error that should be ignored by reporters
 * class NotFoundError extends Data.TaggedError("NotFoundError")<{}> {
 *   readonly [ErrorReporter.ignore] = true
 * }
 *
 * // An error with custom severity and attributes
 * class RateLimitError extends Data.TaggedError("RateLimitError")<{
 *   readonly retryAfter: number
 * }> {
 *   readonly [ErrorReporter.severity] = "Warn" as const
 *   readonly [ErrorReporter.attributes] = {
 *     retryAfter: this.retryAfter
 *   }
 * }
 *
 * // Opt in to error reporting with Effect.withErrorReporting
 * const program = Effect.gen(function*() {
 *   return yield* new RateLimitError({ retryAfter: 60 })
 * }).pipe(
 *   Effect.withErrorReporting,
 *   Effect.provide(ErrorReporter.layer([consoleReporter]))
 * )
 * ```
 *
 * @since 4.0.0
 */
export * as ErrorReporter from "./ErrorReporter.ts"

/**
 * @since 3.16.0
 */
export * as ExecutionPlan from "./ExecutionPlan.ts"

/**
 * Represents the outcome of an Effect computation as a plain, synchronously
 * inspectable value.
 *
 * ## Mental model
 *
 * - `Exit<A, E>` is a union of two cases: `Success<A, E>` and `Failure<A, E>`
 * - A `Success` wraps a value of type `A`
 * - A `Failure` wraps a `Cause<E>`, which may contain typed errors, defects, or interruptions
 * - `Exit` is also an `Effect`, so you can yield it directly inside `Effect.gen`
 * - Constructors mirror the failure modes: {@link fail} for typed errors, {@link die} for defects, {@link interrupt} for fiber interruptions
 * - Use `Exit` when you need to inspect an Effect result without running further effects
 *
 * ## Common tasks
 *
 * - Create a success: {@link succeed}
 * - Create a typed failure: {@link fail}
 * - Create a failure from a Cause: {@link failCause}
 * - Create a defect: {@link die}
 * - Create an interruption: {@link interrupt}
 * - Check the outcome: {@link isSuccess}, {@link isFailure}, {@link match}
 * - Extract values optionally: {@link getSuccess}, {@link getCause}, {@link findErrorOption}
 * - Transform the result: {@link map}, {@link mapError}, {@link mapBoth}
 * - Combine multiple exits: {@link asVoidAll}
 * - Inspect failure categories: {@link hasFails}, {@link hasDies}, {@link hasInterrupts}
 *
 * ## Gotchas
 *
 * - A `Failure` wraps a `Cause<E>`, not a bare `E`. Use Cause utilities to drill into it.
 * - {@link mapError} and {@link mapBoth} only transform typed errors (Fail reasons in the Cause). If the Cause contains only defects or interruptions, the original failure passes through unchanged.
 * - Filter-based APIs ({@link filterSuccess}, {@link filterValue}, etc.) return `Filter.fail` markers for pipeline composition. They are not `Option` values or Effect failures.
 * - {@link findError} and {@link findDefect} return only the first matching reason from the Cause.
 *
 * ## Quickstart
 *
 * **Example** (Creating and inspecting exits)
 *
 * ```ts
 * import { Exit } from "effect"
 *
 * const success = Exit.succeed(42)
 * const failure = Exit.fail("not found")
 *
 * const message = Exit.match(success, {
 *   onSuccess: (value) => `Got: ${value}`,
 *   onFailure: () => "Failed"
 * })
 * console.log(message) // "Got: 42"
 * ```
 *
 * ## See also
 *
 * - {@link Exit} the core union type
 * - {@link succeed} and {@link fail} the most common constructors
 * - {@link match} for pattern matching on an Exit
 *
 * @since 2.0.0
 */
export * as Exit from "./Exit.ts"

/**
 * This module provides utilities for working with `Fiber`, the fundamental unit of
 * concurrency in Effect. Fibers are lightweight, user-space threads that allow
 * multiple Effects to run concurrently with structured concurrency guarantees.
 *
 * Key characteristics of Fibers:
 * - **Lightweight**: Much lighter than OS threads, you can create millions
 * - **Structured concurrency**: Parent fibers manage child fiber lifecycles
 * - **Cancellation safety**: Proper resource cleanup when interrupted
 * - **Cooperative**: Fibers yield control at effect boundaries
 * - **Traceable**: Each fiber has an ID for debugging and monitoring
 *
 * Common patterns:
 * - **Fork and join**: Start concurrent work and wait for results
 * - **Race conditions**: Run multiple effects, take the first to complete
 * - **Supervision**: Monitor and restart failed fibers
 * - **Resource management**: Ensure proper cleanup on interruption
 *
 * @example
 * ```ts
 * import { Console, Effect, Fiber } from "effect"
 *
 * // Basic fiber operations
 * const basicExample = Effect.gen(function*() {
 *   // Fork an effect to run concurrently
 *   const fiber = yield* Effect.forkChild(
 *     Effect.gen(function*() {
 *       yield* Effect.sleep("2 seconds")
 *       yield* Console.log("Background task completed")
 *       return "background result"
 *     })
 *   )
 *
 *   // Do other work while the fiber runs
 *   yield* Console.log("Doing other work...")
 *   yield* Effect.sleep("1 second")
 *
 *   // Wait for the fiber to complete
 *   const result = yield* Fiber.join(fiber)
 *   yield* Console.log(`Fiber result: ${result}`)
 * })
 *
 * // Joining multiple fibers
 * const joinExample = Effect.gen(function*() {
 *   const task1 = Effect.delay(Effect.succeed("task1"), "1 second")
 *   const task2 = Effect.delay(Effect.succeed("task2"), "2 seconds")
 *
 *   // Start both effects as fibers
 *   const fiber1 = yield* Effect.forkChild(task1)
 *   const fiber2 = yield* Effect.forkChild(task2)
 *
 *   // Wait for both to complete
 *   const result1 = yield* Fiber.join(fiber1)
 *   const result2 = yield* Fiber.join(fiber2)
 *   return [result1, result2] // ["task1", "task2"]
 * })
 *
 * // Parallel execution with structured concurrency
 * const parallelExample = Effect.gen(function*() {
 *   const tasks = [1, 2, 3, 4, 5].map((n) =>
 *     Effect.gen(function*() {
 *       yield* Effect.sleep(`${n * 100} millis`)
 *       return n * n
 *     })
 *   )
 *
 *   // Run all tasks in parallel, wait for all to complete
 *   const results = yield* Effect.all(tasks, { concurrency: "unbounded" })
 *   return results // [1, 4, 9, 16, 25]
 * })
 * ```
 *
 * @since 2.0.0
 */
export * as Fiber from "./Fiber.ts"

/**
 * @since 2.0.0
 */
export * as FiberHandle from "./FiberHandle.ts"

/**
 * @since 2.0.0
 */
export * as FiberMap from "./FiberMap.ts"

/**
 * @since 2.0.0
 */
export * as FiberSet from "./FiberSet.ts"

/**
 * This module provides a comprehensive file system abstraction that supports both synchronous
 * and asynchronous file operations through Effect. It includes utilities for file I/O, directory
 * management, permissions, timestamps, and file watching with proper error handling.
 *
 * The `FileSystem` interface provides a cross-platform abstraction over file system operations,
 * allowing you to work with files and directories in a functional, composable way. All operations
 * return `Effect` values that can be composed, transformed, and executed safely.
 *
 * @example
 * ```ts
 * import { Console, Effect, FileSystem } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const fs = yield* FileSystem.FileSystem
 *
 *   // Create a directory
 *   yield* fs.makeDirectory("./temp", { recursive: true })
 *
 *   // Write a file
 *   yield* fs.writeFileString("./temp/hello.txt", "Hello, World!")
 *
 *   // Read the file back
 *   const content = yield* fs.readFileString("./temp/hello.txt")
 *   yield* Console.log("File content:", content)
 *
 *   // Get file information
 *   const stats = yield* fs.stat("./temp/hello.txt")
 *   yield* Console.log("File size:", stats.size)
 *
 *   // Clean up
 *   yield* fs.remove("./temp", { recursive: true })
 * })
 * ```
 *
 * @since 4.0.0
 */
export * as FileSystem from "./FileSystem.ts"

/**
 * @since 4.0.0
 */
export * as Filter from "./Filter.ts"

/**
 * Utilities for converting arbitrary JavaScript values into human-readable
 * strings, with support for circular references, redaction, and common JS
 * types that `JSON.stringify` handles poorly.
 *
 * Mental model:
 * - A `Formatter<Value, Format>` is a callable `(value: Value) => Format`.
 * - {@link format} is the general-purpose pretty-printer: it handles
 *   primitives, arrays, objects, `BigInt`, `Symbol`, `Date`, `RegExp`,
 *   `Set`, `Map`, class instances, and circular references.
 * - {@link formatJson} is a safe `JSON.stringify` wrapper that silently
 *   drops circular references and applies redaction.
 * - Both functions accept a `space` option for indentation control.
 *
 * Common tasks:
 * - Pretty-print any value for debugging / logging -> {@link format}
 * - Serialize to JSON safely (no circular throws) -> {@link formatJson}
 * - Format a single object property key -> {@link formatPropertyKey}
 * - Format a property path like `["a"]["b"]` -> {@link formatPath}
 * - Format a `Date` to ISO string safely -> {@link formatDate}
 *
 * Gotchas:
 * - {@link format} output is **not** valid JSON; use {@link formatJson} when
 *   you need parseable JSON.
 * - {@link format} calls `toString()` on objects by default; pass
 *   `ignoreToString: true` to disable.
 * - {@link formatJson} silently omits circular references (the key is
 *   dropped from the output).
 * - Values implementing the `Redactable` protocol are automatically
 *   redacted by both {@link format} and {@link formatJson}.
 *
 * **Example** (Pretty-print a value)
 *
 * ```ts
 * import { Formatter } from "effect"
 *
 * const obj = { name: "Alice", scores: [100, 97] }
 * console.log(Formatter.format(obj))
 * // {"name":"Alice","scores":[100,97]}
 *
 * console.log(Formatter.format(obj, { space: 2 }))
 * // {
 * //   "name": "Alice",
 * //   "scores": [
 * //     100,
 * //     97
 * //   ]
 * // }
 * ```
 *
 * See also: {@link Formatter}, {@link format}, {@link formatJson}
 *
 * @since 4.0.0
 */
export * as Formatter from "./Formatter.ts"

/**
 * @since 2.0.0
 */
export * as Function from "./Function.ts"

/**
 * @since 4.0.0
 */
export * as Graph from "./Graph.ts"

/**
 * This module provides utilities for hashing values in TypeScript.
 *
 * Hashing is the process of converting data into a fixed-size numeric value,
 * typically used for data structures like hash tables, equality comparisons,
 * and efficient data storage.
 *
 * @since 2.0.0
 */
export * as Hash from "./Hash.ts"

/**
 * @since 2.0.0
 */
export * as HashMap from "./HashMap.ts"

/**
 * @since 4.0.0
 */
export * as HashRing from "./HashRing.ts"

/**
 * @since 2.0.0
 */
export * as HashSet from "./HashSet.ts"

/**
 * This module provides utilities for Higher-Kinded Types (HKT) in TypeScript.
 *
 * Higher-Kinded Types are types that take other types as parameters, similar to how
 * functions take values as parameters. They enable generic programming over type
 * constructors, allowing you to write code that works with any container type
 * (like Array, Option, Effect, etc.) in a uniform way.
 *
 * The HKT system in Effect uses TypeLambdas to encode type-level functions that
 * can represent complex type relationships with multiple type parameters, including
 * contravariant, covariant, and invariant positions.
 *
 * @example
 * ```ts
 * import type { HKT } from "effect"
 *
 * // Define a TypeLambda for Array
 * interface ArrayTypeLambda extends HKT.TypeLambda {
 *   readonly type: Array<this["Target"]>
 * }
 *
 * // Use Kind to get the concrete type
 * type MyArray = HKT.Kind<ArrayTypeLambda, never, never, never, string>
 * // MyArray is Array<string>
 *
 * // Define a TypeClass that works with any HKT
 * interface Functor<F extends HKT.TypeLambda> extends HKT.TypeClass<F> {
 *   map<A, B>(
 *     fa: HKT.Kind<F, never, never, never, A>,
 *     f: (a: A) => B
 *   ): HKT.Kind<F, never, never, never, B>
 * }
 * ```
 *
 * @since 2.0.0
 */
export * as HKT from "./HKT.ts"

/**
 * This module provides utilities for making values inspectable and debuggable in TypeScript.
 *
 * The Inspectable interface provides a standard way to implement custom string representations
 * for objects, making them easier to debug and inspect. It includes support for JSON
 * serialization, Node.js inspection, and safe circular reference handling.
 *
 * The module also includes redaction capabilities for sensitive data, allowing objects
 * to provide different representations based on the current execution context.
 *
 * @example
 * ```ts
 * import { Inspectable } from "effect"
 * import { format } from "effect/Formatter"
 *
 * class User extends Inspectable.Class {
 *   constructor(
 *     public readonly name: string,
 *     public readonly email: string
 *   ) {
 *     super()
 *   }
 *
 *   toJSON() {
 *     return {
 *       _tag: "User",
 *       name: this.name,
 *       email: this.email
 *     }
 *   }
 * }
 *
 * const user = new User("Alice", "alice@example.com")
 * console.log(user.toString()) // Pretty printed JSON
 * console.log(format(user)) // Same as toString()
 * ```
 *
 * @since 2.0.0
 */
export * as Inspectable from "./Inspectable.ts"

/**
 * This module provides utility functions for working with Iterables in TypeScript.
 *
 * Iterables are objects that implement the iterator protocol, allowing them to be
 * consumed with `for...of` loops, spread syntax, and other iteration constructs.
 * This module provides a comprehensive set of functions for creating, transforming,
 * and working with iterables in a functional programming style.
 *
 * Unlike arrays, iterables can be lazy and potentially infinite, making them suitable
 * for stream processing and memory-efficient data manipulation. All functions in this
 * module preserve the lazy nature of iterables where possible.
 *
 * @example
 * ```ts
 * import { Iterable, Option } from "effect"
 *
 * // Create iterables
 * const numbers = Iterable.range(1, 5)
 * const doubled = Iterable.map(numbers, (x) => x * 2)
 * const filtered = Iterable.filter(doubled, (x) => x > 5)
 *
 * console.log(Array.from(filtered)) // [6, 8, 10]
 *
 * // Infinite iterables
 * const fibonacci = Iterable.unfold([0, 1], ([a, b]) => Option.some([a, [b, a + b]]))
 * const first10 = Iterable.take(fibonacci, 10)
 * console.log(Array.from(first10)) // [0, 1, 1, 2, 3, 5, 8, 13, 21, 34]
 * ```
 *
 * @since 2.0.0
 */
export * as Iterable from "./Iterable.ts"

/**
 * JSON Patch operations for transforming JSON documents.
 *
 * This module implements a subset of RFC 6902, providing operations that can be applied deterministically without additional context. It supports computing structural diffs between JSON values and applying patches to transform documents.
 *
 * ## Mental model
 *
 * - **JSON Patch**: An ordered sequence of operations that transform a document from one state to another
 * - **JSON Pointer**: Path syntax for targeting specific locations in a JSON document (e.g., `/users/0/name`)
 * - **Operations**: Three types - `add` (insert value), `remove` (delete value), `replace` (update value)
 * - **Immutable transformations**: All operations return new values; inputs are never mutated
 * - **Sequential application**: Operations are applied in order, with later operations observing changes from earlier ones
 * - **Structural diff**: The `get` function computes differences by comparing structure, not content semantics
 *
 * ## Common tasks
 *
 * - Computing diffs between JSON values → {@link get}
 * - Applying patches to transform documents → {@link apply}
 * - Creating patches manually → {@link JsonPatchOperation}
 * - Storing and validating patch documents → {@link JsonPatch}
 *
 * ## Gotchas
 *
 * - Array removals are emitted from highest index to lowest to avoid index shifting during application
 * - Root operations use an empty string path `""` to target the entire document
 * - Array append operations use `-` as the last token in the path (e.g., `/items/-`)
 * - Generated patches are deterministic but not guaranteed to be minimal
 * - Empty patches return the original document reference (no allocation)
 * - Invalid paths or operations throw errors rather than returning a result type
 *
 * ## Quickstart
 *
 * **Example** (Computing and applying a patch)
 *
 * ```ts
 * import * as JsonPatch from "effect/JsonPatch"
 *
 * const oldValue = { name: "Alice", age: 30 }
 * const newValue = { name: "Alice", age: 31, city: "NYC" }
 *
 * const patch = JsonPatch.get(oldValue, newValue)
 * // [{ op: "replace", path: "/age", value: 31 }, { op: "add", path: "/city", value: "NYC" }]
 *
 * const result = JsonPatch.apply(patch, oldValue)
 * // { name: "Alice", age: 31, city: "NYC" }
 * ```
 *
 * ## See also
 *
 * - {@link JsonPointer} - Utilities for working with JSON Pointer paths
 * - {@link Schema.Json} - The JSON value type used by this module
 *
 * @since 4.0.0
 */
export * as JsonPatch from "./JsonPatch.ts"

/**
 * Utilities for escaping and unescaping JSON Pointer reference tokens according to RFC 6901.
 *
 * JSON Pointer (RFC 6901) defines a string syntax for identifying a specific value within a JSON document.
 * A JSON Pointer is a sequence of reference tokens separated by forward slashes (`/`). Each reference token
 * must be escaped when it contains special characters (`~` or `/`).
 *
 * ## Mental model
 *
 * - **Reference token**: A single segment of a JSON Pointer path (e.g., `"foo"`, `"bar/baz"`, `"key~with~tilde"`)
 * - **Escaping**: Encoding special characters in a token so it can be safely used in a JSON Pointer (`~` → `~0`, `/` → `~1`)
 * - **Unescaping**: Decoding escaped characters back to their original form (`~0` → `~`, `~1` → `/`)
 * - **RFC 6901 compliance**: These functions implement the standard escaping rules for JSON Pointer reference tokens
 * - **Pure functions**: Both operations are pure, immutable, and have no side effects
 *
 * ## Common tasks
 *
 * - Building JSON Pointers from path segments → {@link escapeToken}
 * - Parsing JSON Pointers to extract original token values → {@link unescapeToken}
 * - Escaping object keys or path segments before constructing JSON Pointers → {@link escapeToken}
 * - Extracting unescaped identifiers from JSON Pointer strings → {@link unescapeToken}
 *
 * ## Gotchas
 *
 * - These functions operate on **reference tokens**, not full JSON Pointers. A full JSON Pointer like `/foo/bar` must be split into tokens (`["foo", "bar"]`) before escaping/unescaping
 * - The order of replacement operations matters: `escapeToken` replaces `~` before `/` to avoid double-escaping
 * - Empty strings are valid tokens and are returned unchanged
 * - These functions do not validate JSON Pointer syntax; they only handle token-level escaping
 *
 * ## Quickstart
 *
 * **Example** (Building and parsing a JSON Pointer)
 *
 * ```ts
 * import { escapeToken, unescapeToken } from "effect/JsonPointer"
 *
 * // Build a JSON Pointer from path segments
 * const segments = ["users", "name/alias", "value"]
 * const pointer = "/" + segments.map(escapeToken).join("/")
 * // "/users/name~1alias/value"
 *
 * // Parse a JSON Pointer back to segments
 * const tokens = pointer.split("/").slice(1).map(unescapeToken)
 * // ["users", "name/alias", "value"]
 * ```
 *
 * ## See also
 *
 * - {@link JsonPatch} - Uses these utilities for JSON Patch operations
 * - {@link JsonSchema} - Uses these utilities for schema reference resolution
 *
 * @since 4.0.0
 */
export * as JsonPointer from "./JsonPointer.ts"

/**
 * Convert JSON Schema documents between dialects (Draft-07, Draft-2020-12,
 * OpenAPI 3.0, OpenAPI 3.1). All dialects are normalized to an internal
 * `Document<"draft-2020-12">` representation before optional conversion to
 * an output dialect.
 *
 * ## Mental model
 *
 * - **JsonSchema** — a plain object with string keys; represents any single
 *   JSON Schema node.
 * - **Dialect** — one of `"draft-07"`, `"draft-2020-12"`, `"openapi-3.1"`,
 *   or `"openapi-3.0"`.
 * - **Document** — a structured container holding a root `schema`, its
 *   companion `definitions`, and the target `dialect`. Definitions are
 *   stored separately from the root schema so they can be relocated when
 *   converting between dialects.
 * - **MultiDocument** — same as `Document` but carries multiple root
 *   schemas (at least one). Useful when generating several schemas that
 *   share a single definitions pool.
 * - **Definitions** — a `Record<string, JsonSchema>` keyed by definition
 *   name. The ref pointer prefix depends on the dialect.
 * - **`from*` functions** — parse a raw JSON Schema object into the
 *   canonical `Document<"draft-2020-12">`.
 * - **`to*` functions** — convert from the canonical representation to a
 *   specific output dialect.
 *
 * ## Common tasks
 *
 * - Parse a Draft-07 schema → {@link fromSchemaDraft07}
 * - Parse a Draft-2020-12 schema → {@link fromSchemaDraft2020_12}
 * - Parse an OpenAPI 3.1 schema → {@link fromSchemaOpenApi3_1}
 * - Parse an OpenAPI 3.0 schema → {@link fromSchemaOpenApi3_0}
 * - Convert to Draft-07 output → {@link toDocumentDraft07}
 * - Convert to OpenAPI 3.1 output → {@link toMultiDocumentOpenApi3_1}
 * - Resolve a `$ref` against definitions → {@link resolve$ref}
 * - Inline the root `$ref` of a document → {@link resolveTopLevel$ref}
 *
 * ## Gotchas
 *
 * - All `from*` functions normalize to `Document<"draft-2020-12">`
 *   regardless of the input dialect.
 * - Unsupported or unrecognized JSON Schema keywords are silently dropped
 *   during conversion.
 * - Draft-07 tuple syntax (`items` as array + `additionalItems`) is
 *   converted to 2020-12 form (`prefixItems` + `items`), and vice-versa.
 * - OpenAPI 3.0 `nullable: true` is expanded into `type` arrays or
 *   `anyOf` unions. The `nullable` keyword is removed.
 * - OpenAPI 3.0 singular `example` is converted to `examples` (array).
 * - {@link resolve$ref} only looks up the last segment of the ref path in
 *   the definitions map; it does not follow arbitrary JSON Pointer paths.
 *
 * ## Quickstart
 *
 * **Example** (Parse a Draft-07 schema and convert to Draft-07 output)
 *
 * ```ts
 * import { JsonSchema } from "effect"
 *
 * const raw: JsonSchema.JsonSchema = {
 *   type: "object",
 *   properties: {
 *     name: { type: "string" }
 *   },
 *   required: ["name"]
 * }
 *
 * // Parse into canonical form
 * const doc = JsonSchema.fromSchemaDraft07(raw)
 *
 * // Convert back to Draft-07
 * const draft07 = JsonSchema.toDocumentDraft07(doc)
 *
 * console.log(draft07.dialect) // "draft-07"
 * console.log(draft07.schema) // { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
 * ```
 *
 * ## See also
 *
 * - {@link Document}
 * - {@link MultiDocument}
 * - {@link fromSchemaDraft07}
 * - {@link toDocumentDraft07}
 * - {@link resolve$ref}
 *
 * @since 4.0.0
 */
export * as JsonSchema from "./JsonSchema.ts"

/**
 * @since 3.8.0
 */
export * as Latch from "./Latch.ts"

/**
 * A `Layer<ROut, E, RIn>` describes how to build one or more services in your
 * application. Services can be injected into effects via
 * `Effect.provideService`. Effects can require services via `Effect.service`.
 *
 * Layer can be thought of as recipes for producing bundles of services, given
 * their dependencies (other services).
 *
 * Construction of services can be effectful and utilize resources that must be
 * acquired and safely released when the services are done being utilized.
 *
 * By default layers are shared, meaning that if the same layer is used twice
 * the layer will only be allocated a single time.
 *
 * Because of their excellent composition properties, layers are the idiomatic
 * way in Effect-TS to create services that depend on other services.
 *
 * @since 2.0.0
 */
export * as Layer from "./Layer.ts"

/**
 * @since 3.14.0
 */
export * as LayerMap from "./LayerMap.ts"

/**
 * @since 2.0.0
 *
 * The `Logger` module provides a robust and flexible logging system for Effect applications.
 * It offers structured logging, multiple output formats, and seamless integration with the
 * Effect runtime's tracing and context management.
 *
 * ## Key Features
 *
 * - **Structured Logging**: Built-in support for structured log messages with metadata
 * - **Multiple Formats**: JSON, LogFmt, Pretty, and custom formatting options
 * - **Context Integration**: Automatic capture of fiber context, spans, and annotations
 * - **Batching**: Efficient log aggregation and batch processing
 * - **File Output**: Direct file writing with configurable batch windows
 * - **Composable**: Transform and compose loggers using functional patterns
 *
 * ## Basic Usage
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * // Basic logging
 * const program = Effect.gen(function*() {
 *   yield* Effect.log("Application started")
 *   yield* Effect.logInfo("Processing user request")
 *   yield* Effect.logWarning("Resource limit approaching")
 *   yield* Effect.logError("Database connection failed")
 * })
 *
 * // With structured data
 * const structuredLog = Effect.gen(function*() {
 *   yield* Effect.log("User action", { userId: 123, action: "login" })
 *   yield* Effect.logInfo("Request processed", { duration: 150, statusCode: 200 })
 * })
 * ```
 *
 * ## Custom Loggers
 *
 * ```ts
 * import { Effect, Logger } from "effect"
 *
 * // Create a custom logger
 * const customLogger = Logger.make((options) => {
 *   console.log(`[${options.logLevel}] ${options.message}`)
 * })
 *
 * // Use JSON format for production
 * const jsonLogger = Logger.consoleJson
 *
 * // Pretty format for development
 * const prettyLogger = Logger.consolePretty()
 *
 * const program = Effect.log("Hello World").pipe(
 *   Effect.provide(Logger.layer([jsonLogger]))
 * )
 * ```
 *
 * ## Multiple Loggers
 *
 * ```ts
 * import { Effect, Logger } from "effect"
 *
 * // Combine multiple loggers
 * const CombinedLoggerLive = Logger.layer([
 *   Logger.consoleJson,
 *   Logger.consolePretty()
 * ])
 *
 * const program = Effect.log("Application event").pipe(
 *   Effect.provide(CombinedLoggerLive)
 * )
 * ```
 *
 * ## Batched Logging
 *
 * ```ts
 * import { Duration, Effect, Logger } from "effect"
 *
 * const batchedLogger = Logger.batched(Logger.formatJson, {
 *   window: Duration.seconds(5),
 *   flush: (messages) =>
 *     Effect.sync(() => {
 *       // Process batch of log messages
 *       console.log("Flushing", messages.length, "log entries")
 *     })
 * })
 *
 * const program = Effect.gen(function*() {
 *   const logger = yield* batchedLogger
 *   yield* Effect.provide(
 *     Effect.all([
 *       Effect.log("Event 1"),
 *       Effect.log("Event 2"),
 *       Effect.log("Event 3")
 *     ]),
 *     Logger.layer([logger])
 *   )
 * })
 * ```
 */
export * as Logger from "./Logger.ts"

/**
 * @since 2.0.0
 *
 * The `LogLevel` module provides utilities for managing log levels in Effect applications.
 * It defines a hierarchy of log levels and provides functions for comparing and filtering logs
 * based on their severity.
 *
 * ## Log Level Hierarchy
 *
 * The log levels are ordered from most severe to least severe:
 *
 * 1. **All** - Special level that allows all messages
 * 2. **Fatal** - System is unusable, immediate attention required
 * 3. **Error** - Error conditions that should be investigated
 * 4. **Warn** - Warning conditions that may indicate problems
 * 5. **Info** - Informational messages about normal operation
 * 6. **Debug** - Debug information useful during development
 * 7. **Trace** - Very detailed trace information
 * 8. **None** - Special level that suppresses all messages
 *
 * ## Basic Usage
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * // Basic log level usage
 * const program = Effect.gen(function*() {
 *   yield* Effect.logFatal("System is shutting down")
 *   yield* Effect.logError("Database connection failed")
 *   yield* Effect.logWarning("Memory usage is high")
 *   yield* Effect.logInfo("User logged in")
 *   yield* Effect.logDebug("Processing request")
 *   yield* Effect.logTrace("Variable value: xyz")
 * })
 * ```
 *
 * ## Level Comparison
 *
 * ```ts
 * import { LogLevel } from "effect"
 *
 * // Check if one level is more severe than another
 * console.log(LogLevel.isGreaterThan("Error", "Info")) // true
 * console.log(LogLevel.isGreaterThan("Debug", "Error")) // false
 *
 * // Check if level meets minimum threshold
 * console.log(LogLevel.isGreaterThanOrEqualTo("Info", "Debug")) // true
 * console.log(LogLevel.isLessThan("Trace", "Info")) // true
 * ```
 *
 * ## Filtering by Level
 *
 * ```ts
 * import { Logger, LogLevel } from "effect"
 *
 * // Create a logger that only logs Error and above
 * const errorLogger = Logger.make((options) => {
 *   if (LogLevel.isGreaterThanOrEqualTo(options.logLevel, "Error")) {
 *     console.log(`[${options.logLevel}] ${options.message}`)
 *   }
 * })
 *
 * // Production logger - Info and above
 * const productionLogger = Logger.make((options) => {
 *   if (LogLevel.isGreaterThanOrEqualTo(options.logLevel, "Info")) {
 *     console.log(
 *       `${options.date.toISOString()} [${options.logLevel}] ${options.message}`
 *     )
 *   }
 * })
 *
 * // Development logger - Debug and above
 * const devLogger = Logger.make((options) => {
 *   if (LogLevel.isGreaterThanOrEqualTo(options.logLevel, "Debug")) {
 *     console.log(`[${options.logLevel}] ${options.message}`)
 *   }
 * })
 * ```
 *
 * ## Runtime Configuration
 *
 * ```ts
 * import { Config, Effect, Logger, LogLevel } from "effect"
 *
 * // Configure log level from environment
 * const logLevelConfig = Config.string("LOG_LEVEL").pipe(
 *   Config.withDefault("Info")
 * )
 *
 * const configurableLogger = Effect.gen(function*() {
 *   const minLevel = yield* logLevelConfig
 *
 *   return Logger.make((options) => {
 *     if (LogLevel.isGreaterThanOrEqualTo(options.logLevel, minLevel)) {
 *       console.log(`[${options.logLevel}] ${options.message}`)
 *     }
 *   })
 * })
 * ```
 */
export * as LogLevel from "./LogLevel.ts"

/**
 * @since 2.0.0
 */
export * as ManagedRuntime from "./ManagedRuntime.ts"

/**
 * The `effect/match` module provides a type-safe pattern matching system for
 * TypeScript. Inspired by functional programming, it simplifies conditional
 * logic by replacing verbose if/else or switch statements with a structured and
 * expressive API.
 *
 * This module supports matching against types, values, and discriminated unions
 * while enforcing exhaustiveness checking to ensure all cases are handled.
 *
 * Although pattern matching is not yet a native JavaScript feature,
 * `effect/match` offers a reliable implementation that is available today.
 *
 * **How Pattern Matching Works**
 *
 * Pattern matching follows a structured process:
 *
 * - **Creating a matcher**: Define a `Matcher` that operates on either a
 *   specific `Match.type` or `Match.value`.
 *
 * - **Defining patterns**: Use combinators such as `Match.when`, `Match.not`,
 *   and `Match.tag` to specify matching conditions.
 *
 * - **Completing the match**: Apply a finalizer such as `Match.exhaustive`,
 *   `Match.orElse`, or `Match.option` to determine how unmatched cases should
 *   be handled.
 *
 * @since 4.0.0
 */
export * as Match from "./Match.ts"

/**
 * @since 2.0.0
 *
 * The `Metric` module provides a comprehensive system for collecting, aggregating, and observing
 * application metrics in Effect applications. It offers type-safe, concurrent metrics that can
 * be used to monitor performance, track business metrics, and gain insights into application behavior.
 *
 * ## Key Features
 *
 * - **Five Metric Types**: Counters, Gauges, Frequencies, Histograms, and Summaries
 * - **Type Safety**: Fully typed metrics with compile-time guarantees
 * - **Concurrency Safe**: Thread-safe metrics that work with Effect's concurrency model
 * - **Attributes**: Tag metrics with key-value attributes for filtering and grouping
 * - **Snapshots**: Take point-in-time snapshots of all metrics for reporting
 * - **Runtime Integration**: Automatic fiber runtime metrics collection
 *
 * ## Metric Types
 *
 * ### Counter
 * Tracks cumulative values that only increase or can be reset to zero.
 * Perfect for counting events, requests, errors, etc.
 *
 * ### Gauge
 * Represents a single numerical value that can go up or down.
 * Ideal for current resource usage, temperature, queue sizes, etc.
 *
 * ### Frequency
 * Counts occurrences of discrete string values.
 * Useful for tracking categorical data like HTTP status codes, user actions, etc.
 *
 * ### Histogram
 * Records observations in configurable buckets to analyze distribution.
 * Great for response times, request sizes, and other measured values.
 *
 * ### Summary
 * Calculates quantiles over a sliding time window.
 * Provides statistical insights into value distributions over time.
 *
 * ## Basic Usage
 *
 * ```ts
 * import { Effect, Metric } from "effect"
 *
 * // Create metrics
 * const requestCount = Metric.counter("http_requests_total", {
 *   description: "Total number of HTTP requests"
 * })
 *
 * const responseTime = Metric.histogram("http_response_time", {
 *   description: "HTTP response time in milliseconds",
 *   boundaries: Metric.linearBoundaries({ start: 0, width: 50, count: 20 })
 * })
 *
 * // Use metrics in your application
 * const handleRequest = Effect.gen(function*() {
 *   yield* Metric.update(requestCount, 1)
 *
 *   const startTime = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
 *
 *   // Process request...
 *   yield* Effect.sleep("100 millis")
 *
 *   const endTime = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
 *   yield* Metric.update(responseTime, endTime - startTime)
 * })
 * ```
 *
 * ## Attributes and Tagging
 *
 * ```ts
 * import { Effect, Metric } from "effect"
 *
 * const requestCount = Metric.counter("requests", {
 *   description: "Number of requests by endpoint and method"
 * })
 *
 * const program = Effect.gen(function*() {
 *   // Add attributes to metrics
 *   yield* Metric.update(
 *     Metric.withAttributes(requestCount, {
 *       endpoint: "/api/users",
 *       method: "GET"
 *     }),
 *     1
 *   )
 *
 *   // Or use withAttributes for compile-time attributes
 *   const taggedCounter = Metric.withAttributes(requestCount, {
 *     endpoint: "/api/posts",
 *     method: "POST"
 *   })
 *   yield* Metric.update(taggedCounter, 1)
 * })
 * ```
 *
 * ## Advanced Examples
 *
 * ```ts
 * import { Effect, Metric } from "effect"
 *
 * // Business metrics
 * const userSignups = Metric.counter("user_signups_total")
 * const activeUsers = Metric.gauge("active_users_current")
 * const featureUsage = Metric.frequency("feature_usage")
 *
 * // Performance metrics
 * const dbQueryTime = Metric.summary("db_query_duration", {
 *   maxAge: "5 minutes",
 *   maxSize: 1000,
 *   quantiles: [0.5, 0.9, 0.95, 0.99]
 * })
 *
 * const program = Effect.gen(function*() {
 *   // Track user signup
 *   yield* Metric.update(userSignups, 1)
 *
 *   // Update active user count
 *   yield* Metric.update(activeUsers, 1250)
 *
 *   // Record feature usage
 *   yield* Metric.update(featureUsage, "dashboard_view")
 *
 *   // Measure database query time
 *   yield* Effect.timed(performDatabaseQuery).pipe(
 *     Effect.tap(([duration]) => Metric.update(dbQueryTime, duration))
 *   )
 * })
 *
 * // Get metric snapshots
 * const getMetrics = Effect.gen(function*() {
 *   const snapshots = yield* Metric.snapshot
 *
 *   for (const metric of snapshots) {
 *     console.log(`${metric.id}: ${JSON.stringify(metric.state)}`)
 *   }
 * })
 * ```
 */
export * as Metric from "./Metric.ts"

/**
 * MutableHashMap is a high-performance, mutable hash map implementation designed for efficient key-value storage
 * with support for both structural and referential equality. It provides O(1) average-case performance for
 * basic operations and integrates seamlessly with Effect's Equal and Hash interfaces.
 *
 * The implementation uses a hybrid approach:
 * - Referential keys (without Equal implementation) are stored in a native Map
 * - Structural keys (with Equal implementation) are stored in hash buckets with collision handling
 *
 * Key Features:
 * - Mutable operations for performance-critical scenarios
 * - Supports both structural and referential equality
 * - Efficient collision handling through bucketing
 * - Iterable interface for easy traversal
 * - Memory-efficient storage with automatic bucket management
 *
 * Performance Characteristics:
 * - Get/Set/Has: O(1) average, O(n) worst case (hash collisions)
 * - Remove: O(1) average, O(n) worst case
 * - Clear: O(1)
 * - Size: O(1)
 * - Iteration: O(n)
 *
 * @since 2.0.0
 * @category data-structures
 */
export * as MutableHashMap from "./MutableHashMap.ts"

/**
 * @fileoverview
 * MutableHashSet is a high-performance, mutable set implementation that provides efficient storage
 * and retrieval of unique values. Built on top of MutableHashMap, it inherits the same performance
 * characteristics and support for both structural and referential equality.
 *
 * The implementation uses a MutableHashMap internally where each value is stored as a key with a
 * boolean flag, providing O(1) average-case performance for all operations.
 *
 * Key Features:
 * - Mutable operations for performance-critical scenarios
 * - Supports both structural and referential equality
 * - Efficient duplicate detection and removal
 * - Iterable interface for easy traversal
 * - Memory-efficient storage with automatic deduplication
 * - Seamless integration with Effect's Equal and Hash interfaces
 *
 * Performance Characteristics:
 * - Add/Has/Remove: O(1) average, O(n) worst case (hash collisions)
 * - Clear: O(1)
 * - Size: O(1)
 * - Iteration: O(n)
 *
 * @since 2.0.0
 * @category data-structures
 */
export * as MutableHashSet from "./MutableHashSet.ts"

/**
 * @fileoverview
 * MutableList is an efficient, mutable linked list implementation optimized for high-throughput
 * scenarios like logging, queuing, and streaming. It uses a bucket-based architecture where
 * elements are stored in arrays (buckets) linked together, providing optimal performance for
 * both append and prepend operations.
 *
 * The implementation uses a sophisticated bucket system:
 * - Each bucket contains an array of elements with an offset pointer
 * - Buckets can be marked as mutable or immutable for optimization
 * - Elements are taken from the head and added to the tail
 * - Memory is efficiently managed through bucket reuse and cleanup
 *
 * Key Features:
 * - Highly optimized for high-frequency append/prepend operations
 * - Memory efficient with automatic cleanup of consumed elements
 * - Support for bulk operations (appendAll, prependAll, takeN)
 * - Filtering and removal operations
 * - Zero-copy optimizations for certain scenarios
 *
 * Performance Characteristics:
 * - Append/Prepend: O(1) amortized
 * - Take/TakeN: O(1) per element taken
 * - Length: O(1)
 * - Clear: O(1)
 * - Filter: O(n)
 *
 * Ideal Use Cases:
 * - High-throughput logging systems
 * - Producer-consumer queues
 * - Streaming data buffers
 * - Real-time data processing pipelines
 *
 * @since 4.0.0
 * @category data-structures
 */
export * as MutableList from "./MutableList.ts"

/**
 * @fileoverview
 * MutableRef provides a mutable reference container that allows safe mutation of values
 * in functional programming contexts. It serves as a bridge between functional and imperative
 * programming paradigms, offering atomic operations for state management.
 *
 * Unlike regular variables, MutableRef encapsulates mutable state and provides controlled
 * access through a standardized API. It supports atomic compare-and-set operations for
 * thread-safe updates and integrates seamlessly with Effect's ecosystem.
 *
 * Key Features:
 * - Mutable reference semantics with functional API
 * - Atomic compare-and-set operations for safe concurrent updates
 * - Specialized operations for numeric and boolean values
 * - Chainable operations that return the reference or the value
 * - Integration with Effect's Equal interface for value comparison
 *
 * Common Use Cases:
 * - State containers in functional applications
 * - Counters and accumulators
 * - Configuration that needs to be updated at runtime
 * - Caching and memoization scenarios
 * - Inter-module communication via shared references
 *
 * Performance Characteristics:
 * - Get/Set: O(1)
 * - Compare-and-set: O(1)
 * - All operations: O(1)
 *
 * @since 2.0.0
 * @category data-structures
 */
export * as MutableRef from "./MutableRef.ts"

/**
 * Lightweight wrapper types that prevent accidental mixing of structurally
 * identical values (e.g. `UserId` vs `OrderId`, both `string` at runtime).
 *
 * **Mental model**
 *
 * - **Newtype** — a compile-time wrapper around a **carrier** type (the
 *   underlying primitive or object). At runtime the value is unchanged; the
 *   tag exists only in the type system.
 * - **Key** — a unique string literal that distinguishes one newtype from
 *   another (e.g. `"Label"`, `"UserId"`).
 * - **Carrier** — the underlying type the newtype wraps (e.g. `string`,
 *   `number`).
 * - **Iso** — a lossless two-way conversion between a newtype and its carrier,
 *   created with {@link makeIso}. Use `iso.set(carrier)` to wrap and
 *   `iso.get(newtype)` to unwrap.
 *
 * **Common tasks**
 *
 * - Define a newtype → declare an `interface` extending
 *   `Newtype.Newtype<Key, Carrier>`
 * - Wrap / unwrap values → {@link makeIso} (returns an `Optic.Iso`)
 * - Unwrap only → {@link value}
 * - Lift an `Equivalence` → {@link makeEquivalence}
 * - Lift an `Order` → {@link makeOrder}
 * - Lift a `Combiner` → {@link makeCombiner}
 * - Lift a `Reducer` → {@link makeReducer}
 *
 * **Gotchas**
 *
 * - Newtypes are **purely compile-time**. There is zero runtime overhead;
 *   `value` and `makeIso` use identity casts.
 * - Two newtypes sharing the same key string will be assignable to each other.
 *   Choose unique key strings.
 * - A newtype value is **not** assignable to its carrier type without
 *   explicitly unwrapping via {@link value} or an iso.
 *
 * **Quickstart**
 *
 * **Example** (defining and using a newtype)
 *
 * ```ts
 * import { Newtype } from "effect"
 *
 * // 1. Define a newtype
 * interface Label extends Newtype.Newtype<"Label", string> {}
 *
 * // 2. Create an iso for wrapping/unwrapping
 * const labelIso = Newtype.makeIso<Label>()
 *
 * // 3. Wrap a raw string
 * const myLabel: Label = labelIso.set("hello")
 *
 * // 4. Unwrap back to string
 * const raw: string = labelIso.get(myLabel) // "hello"
 * ```
 *
 * **See also**
 *
 * - {@link Newtype} (the tagged interface)
 * - {@link makeIso} (wrap and unwrap)
 * - {@link value} (unwrap only)
 *
 * @since 4.0.0
 */
export * as Newtype from "./Newtype.ts"

/**
 * @since 2.0.0
 *
 * The `NonEmptyIterable` module provides types and utilities for working with iterables
 * that are guaranteed to contain at least one element. This provides compile-time
 * safety when working with collections that must not be empty.
 *
 * ## Key Features
 *
 * - **Type Safety**: Compile-time guarantee that the iterable contains at least one element
 * - **Iterator Protocol**: Fully compatible with JavaScript's built-in iteration protocol
 * - **Functional Operations**: Safe operations that preserve the non-empty property
 * - **Lightweight**: Minimal overhead with maximum type safety
 *
 * ## Why NonEmptyIterable?
 *
 * Many operations require non-empty collections to be meaningful:
 * - Finding the maximum or minimum value
 * - Getting the first or last element
 * - Reducing without an initial value
 * - Operations that would otherwise need runtime checks
 *
 * ## Basic Usage
 *
 * ```ts
 * import * as NonEmptyIterable from "effect/NonEmptyIterable"
 *
 * // NonEmptyIterable is a type that represents any iterable with at least one element
 * function processNonEmpty<A>(data: NonEmptyIterable.NonEmptyIterable<A>): A {
 *   // Safe to get the first element - guaranteed to exist
 *   const [first] = NonEmptyIterable.unprepend(data)
 *   return first
 * }
 *
 * // Using Array.make to create non-empty arrays
 * const numbers = Array.make(
 *   1,
 *   2,
 *   3,
 *   4,
 *   5
 * ) as unknown as NonEmptyIterable.NonEmptyIterable<number>
 * const firstNumber = processNonEmpty(numbers) // number
 *
 * // Regular arrays can be asserted as NonEmptyIterable when known to be non-empty
 * const values = [1, 2, 3] as unknown as NonEmptyIterable.NonEmptyIterable<number>
 * const firstValue = processNonEmpty(values) // number
 *
 * // Custom iterables that are guaranteed non-empty
 * function* generateNumbers(): NonEmptyIterable.NonEmptyIterable<number> {
 *   yield 1
 *   yield 2
 *   yield 3
 * }
 *
 * const firstGenerated = processNonEmpty(generateNumbers()) // number
 * ```
 *
 * ## Working with Different Iterable Types
 *
 * ```ts
 * import { Array } from "effect"
 *
 * // Creating non-empty arrays
 * const nonEmptyArray = Array.make(
 *   1,
 *   2,
 *   3
 * ) as unknown as NonEmptyIterable.NonEmptyIterable<number>
 *
 * // Working with strings (assert as NonEmptyIterable when known to be non-empty)
 * const nonEmptyString = "hello" as unknown as NonEmptyIterable.NonEmptyIterable<
 *   string
 * >
 * const [firstChar] = NonEmptyIterable.unprepend(nonEmptyString)
 * console.log(firstChar) // "h"
 *
 * // Working with Maps (assert when known to be non-empty)
 * const nonEmptyMap = new Map([
 *   ["key1", "value1"],
 *   ["key2", "value2"]
 * ]) as unknown as NonEmptyIterable.NonEmptyIterable<[string, string]>
 * const [firstEntry] = NonEmptyIterable.unprepend(nonEmptyMap)
 * console.log(firstEntry) // ["key1", "value1"]
 *
 * // Custom generator functions
 * function* fibonacci(): NonEmptyIterable.NonEmptyIterable<number> {
 *   let a = 1, b = 1
 *   yield a
 *   while (true) {
 *     yield b
 *     const next = a + b
 *     a = b
 *     b = next
 *   }
 * }
 *
 * const [firstFib, restFib] = NonEmptyIterable.unprepend(
 *   fibonacci() as unknown as NonEmptyIterable.NonEmptyIterable<number>
 * )
 * console.log(firstFib) // 1
 * ```
 *
 * ## Integration with Effect Arrays
 *
 * ```ts
 * import { Array, pipe } from "effect"
 * import type * as NonEmptyIterable from "effect/NonEmptyIterable"
 * import type * as NonEmptyIterable from "effect/NonEmptyIterable"
 *
 * // Many Array functions work with NonEmptyIterable
 * declare const nonEmptyData: NonEmptyIterable.NonEmptyIterable<number>
 *
 * const processData = pipe(
 *   nonEmptyData,
 *   Array.fromIterable,
 *   Array.map((x) => x * 2),
 *   Array.filter((x) => x > 5)
 *   // Result is a regular array since filtering might make it empty
 * )
 *
 * // Safe operations that preserve non-emptiness
 * const doubledData = pipe(
 *   nonEmptyData,
 *   Array.fromIterable,
 *   Array.map((x) => x * 2)
 *   // This would still be non-empty if the source was non-empty
 * )
 * ```
 */
export * as NonEmptyIterable from "./NonEmptyIterable.ts"

/**
 * This module provides utility functions and type class instances for working with the `number` type in TypeScript.
 * It includes functions for basic arithmetic operations.
 *
 * @since 2.0.0
 */
export * as Number from "./Number.ts"

/**
 * Composable, immutable accessors for reading and updating nested data
 * structures without mutation.
 *
 * **Mental model**
 *
 * - **Optic** — a first-class reference to a piece inside a larger structure.
 *   Compose optics to reach deeply nested values.
 * - **Iso** — lossless two-way conversion (`get`/`set`) between `S` and `A`.
 *   Extends both {@link Lens} and {@link Prism}.
 * - **Lens** — focuses on exactly one part of `S`. `get` always succeeds;
 *   `replace` needs the original `S` to produce the updated whole.
 * - **Prism** — focuses on a part that may not be present (e.g. a union
 *   variant). `getResult` can fail; `set` builds a new `S` from `A` alone.
 * - **Optional** — the most general optic: both reading and writing can fail.
 * - **Traversal** — focuses on zero or more elements of an array-like
 *   structure. Technically `Optional<S, ReadonlyArray<A>>`.
 * - **Hierarchy** (strongest → weakest):
 *   `Iso > Lens | Prism > Optional`. Composing a weaker optic with any other
 *   produces the weaker kind.
 *
 * **Common tasks**
 *
 * - Start a chain → {@link id} (identity iso)
 * - Drill into a struct key → `.key("name")` / `.optionalKey("name")`
 * - Drill into a key that may not exist → `.at("name")`
 * - Narrow a tagged union → `.tag("MyVariant")`
 * - Narrow by type guard → `.refine(guard)`
 * - Add validation → `.check(Schema.isGreaterThan(0))`
 * - Filter out `undefined` → `.notUndefined()`
 * - Pick/omit struct keys → `.pick(["a","b"])` / `.omit(["c"])`
 * - Traverse array elements → `.forEach(el => el.key("field"))`
 * - Build an iso → {@link makeIso}
 * - Build a lens → {@link makeLens}
 * - Build a prism → {@link makePrism}, {@link fromChecks}
 * - Build an optional → {@link makeOptional}
 * - Focus into `Option.Some` → {@link some}
 * - Focus into `Result.Success`/`Failure` → {@link success}, {@link failure}
 * - Convert record ↔ entries → {@link entries}
 * - Extract all traversal elements → {@link getAll}
 *
 * **Gotchas**
 *
 * - Updates are structurally persistent: only nodes on the path are cloned.
 *   Unrelated branches keep referential identity. However, **no-op updates
 *   may still allocate** a new root — do not rely on reference identity to
 *   detect no-ops.
 * - `replace` silently returns the original `S` when the optic cannot focus
 *   (e.g. wrong tag). Use `replaceResult` for explicit failure.
 * - `modify` also returns the original `S` on focus failure — it never throws.
 * - `.key()` and `.optionalKey()` do not work on union types (compile error).
 * - Only plain objects (`Object.prototype` or `null` prototype) and arrays can
 *   be cloned. Class instances cause a runtime error on `replace`/`modify`.
 *
 * **Quickstart**
 *
 * **Example** (reading and updating nested state)
 *
 * ```ts
 * import { Optic } from "effect"
 *
 * type State = { user: { name: string; age: number } }
 *
 * const _age = Optic.id<State>().key("user").key("age")
 *
 * const s1: State = { user: { name: "Alice", age: 30 } }
 *
 * // Read
 * console.log(_age.get(s1))
 * // Output: 30
 *
 * // Update immutably
 * const s2 = _age.replace(31, s1)
 * console.log(s2)
 * // Output: { user: { name: "Alice", age: 31 } }
 *
 * // Modify with a function
 * const s3 = _age.modify((n) => n + 1)(s1)
 * console.log(s3)
 * // Output: { user: { name: "Alice", age: 31 } }
 *
 * // Referential identity is preserved for unrelated branches
 * console.log(s2.user !== s1.user)
 * // Output: true (on the path)
 * ```
 *
 * **See also**
 *
 * - {@link id} — entry point for optic chains
 * - {@link Lens} / {@link Prism} / {@link Optional} — core optic types
 * - {@link Traversal} / {@link getAll} — multi-focus optics
 * - {@link some} / {@link success} / {@link failure} — built-in prisms
 *
 * @since 4.0.0
 * @module
 */
export * as Optic from "./Optic.ts"

/**
 * The `Option` module provides a type-safe way to represent values that may or
 * may not exist. An `Option<A>` is either `Some<A>` (containing a value) or
 * `None` (representing absence).
 *
 * **Mental model**
 *
 * - `Option<A>` is a discriminated union: `None | Some<A>`
 * - `None` represents the absence of a value (like `null`/`undefined`, but type-safe)
 * - `Some<A>` wraps a present value of type `A`, accessed via `.value`
 * - `Option` is a monad: chain operations with {@link flatMap}, compose pipelines with `pipe`
 * - All operations are pure and return new `Option` values; the input is never mutated
 * - `Option` is yieldable in `Effect.gen`, producing the inner value or short-circuiting with `NoSuchElementError`
 *
 * **Common tasks**
 *
 * - Create from a value: {@link some}, {@link none}
 * - Create from nullable: {@link fromNullishOr}, {@link fromNullOr}, {@link fromUndefinedOr}
 * - Create from iterable: {@link fromIterable}
 * - Create from Result: {@link getSuccess}, {@link getFailure}
 * - Transform: {@link map}, {@link flatMap}, {@link andThen}
 * - Unwrap: {@link getOrElse}, {@link getOrNull}, {@link getOrUndefined}, {@link getOrThrow}
 * - Pattern match: {@link match}
 * - Fallbacks: {@link orElse}, {@link orElseSome}, {@link firstSomeOf}
 * - Filter: {@link filter}, {@link filterMap}
 * - Combine multiple: {@link all}, {@link zipWith}, {@link product}
 * - Generator syntax: {@link gen}
 * - Do notation: {@link Do}, {@link bind}, {@link let_ let}
 * - Check contents: {@link isSome}, {@link isNone}, {@link contains}, {@link exists}
 *
 * **Gotchas**
 *
 * - `Option.some(null)` is a valid `Some`; use {@link fromNullishOr} to treat `null`/`undefined` as `None`
 * - {@link filterMap} uses a `Filter` callback that returns `Result`
 * - {@link getOrThrow} throws a generic `Error`; prefer {@link getOrThrowWith} for custom errors
 * - `None` is a singleton; compare with {@link isNone}, not `===`
 * - When yielded in `Effect.gen`, a `None` becomes a `NoSuchElementError` defect
 *
 * **Quickstart**
 *
 * **Example** (Working with optional values)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * const name = Option.some("Alice")
 * const age = Option.none<number>()
 *
 * // Transform
 * const upper = Option.map(name, (s) => s.toUpperCase())
 *
 * // Unwrap with fallback
 * console.log(Option.getOrElse(upper, () => "unknown"))
 * // Output: "ALICE"
 *
 * console.log(Option.getOrElse(age, () => 0))
 * // Output: 0
 *
 * // Combine multiple options
 * const both = Option.all({ name, age })
 * console.log(Option.isNone(both))
 * // Output: true
 * ```
 *
 * **See also**
 *
 * - {@link some} / {@link none} for creating values
 * - {@link map} / {@link flatMap} for transforming values
 * - {@link match} for pattern matching
 * - {@link gen} for generator-based syntax
 *
 * @since 2.0.0
 * @module
 */
export * as Option from "./Option.ts"

/**
 * This module provides the `Order` type class for defining total orderings on types.
 * An `Order` is a comparison function that returns `-1` (less than), `0` (equal), or `1` (greater than).
 *
 * Mental model:
 * - An `Order<A>` is a pure function `(a: A, b: A) => Ordering` that compares two values
 * - The result `-1` means the first value is less than the second
 * - The result `0` means the values are equal according to this ordering
 * - The result `1` means the first value is greater than the second
 * - Orders must satisfy total ordering laws: totality (either `x <= y` or `y <= x`), antisymmetry (if `x <= y` and `y <= x` then `x == y`), and transitivity (if `x <= y` and `y <= z` then `x <= z`)
 * - Orders can be composed using {@link combine} and {@link combineAll} to create multi-criteria comparisons
 * - Orders can be transformed using {@link mapInput} to compare values by extracting a comparable property
 * - Built-in orders exist for common types: {@link Number}, {@link String}, {@link Boolean}, {@link BigInt}, {@link Date}
 *
 * Common tasks:
 * - Creating custom orders → {@link make}
 * - Using built-in orders → {@link Number}, {@link String}, {@link Boolean}, {@link BigInt}, {@link Date}
 * - Combining multiple orders → {@link combine}, {@link combineAll}
 * - Transforming orders → {@link mapInput}
 * - Comparing values → {@link isLessThan}, {@link isGreaterThan}, {@link isLessThanOrEqualTo}, {@link isGreaterThanOrEqualTo}
 * - Finding min/max → {@link min}, {@link max}
 * - Clamping values → {@link clamp}, {@link isBetween}
 * - Ordering collections → {@link Array}, {@link Tuple}, {@link Struct}
 *
 * Gotchas:
 * - `Order.Number` treats all `NaN` values as equal and less than any other number
 * - `Order.make` uses reference equality (`===`) as a shortcut: if `self === that`, it returns `0` without calling the comparison function
 * - `Order.Array` compares arrays element-by-element, then by length if all elements are equal; `Order.all` only compares elements up to the shorter array's length
 * - `Order.Tuple` requires a fixed-length tuple with matching order types; `Order.Array` works with variable-length arrays
 * - `Order.min` and `Order.max` return the first argument when values are equal
 *
 * Quickstart:
 *
 * **Example** (Basic Usage)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * const result = Order.Number(5, 10)
 * console.log(result) // -1 (5 is less than 10)
 *
 * const isLessThan = Order.isLessThan(Order.Number)(5, 10)
 * console.log(isLessThan) // true
 * ```
 *
 * See also:
 * - {@link Ordering} - The result type of comparisons
 * - {@link Reducer} - For combining orders in collections
 *
 * @since 2.0.0
 */
export * as Order from "./Order.ts"

/**
 * @fileoverview
 * The Ordering module provides utilities for working with comparison results and ordering operations.
 * An Ordering represents the result of comparing two values, expressing whether the first value is
 * less than (-1), equal to (0), or greater than (1) the second value.
 *
 * This module is fundamental for building comparison functions, sorting algorithms, and implementing
 * ordered data structures. It provides composable operations for combining multiple comparison results
 * and pattern matching on ordering outcomes.
 *
 * Key Features:
 * - Type-safe representation of comparison results (-1, 0, 1)
 * - Composable operations for combining multiple orderings
 * - Pattern matching utilities for handling different ordering cases
 * - Ordering reversal and combination functions
 * - Integration with Effect's functional programming patterns
 *
 * Common Use Cases:
 * - Implementing custom comparison functions
 * - Building complex sorting criteria
 * - Combining multiple comparison results
 * - Creating ordered data structures
 * - Pattern matching on comparison outcomes
 *
 * @since 2.0.0
 * @category utilities
 */
export * as Ordering from "./Ordering.ts"

/**
 * @since 4.0.0
 */
export * as PartitionedSemaphore from "./PartitionedSemaphore.ts"

/**
 * @since 4.0.0
 */
export * as Path from "./Path.ts"

/**
 * @since 2.0.0
 */
export * as Pipeable from "./Pipeable.ts"

/**
 * @since 4.0.0
 */
export * as PlatformError from "./PlatformError.ts"

/**
 * @since 2.0.0
 */
export * as Pool from "./Pool.ts"

/**
 * Predicate and Refinement helpers for runtime checks, filtering, and type narrowing.
 * This module provides small, pure functions you can combine to decide whether a
 * value matches a condition and, when using refinements, narrow TypeScript types.
 *
 * Mental model:
 * - A `Predicate<A>` is just `(a: A) => boolean`.
 * - A `Refinement<A, B>` is a predicate that narrows `A` to `B` when true.
 * - Guards like `isString` are predicates/refinements for common runtime types.
 * - Combinators like `and`/`or` build new predicates from existing ones.
 * - `Tuple` and `Struct` lift element/property predicates to compound values.
 *
 * Common tasks:
 * - Reuse an existing predicate on a different input shape -> {@link mapInput}
 * - Combine checks -> {@link and}, {@link or}, {@link not}, {@link xor}
 * - Build tuple/object checks -> {@link Tuple}, {@link Struct}
 * - Narrow `unknown` to a concrete type -> {@link Refinement}, {@link compose}
 * - Check runtime types -> {@link isString}, {@link isNumber}, {@link isObject}
 *
 * Gotchas:
 * - `isTruthy` uses JavaScript truthiness; `0`, "", and `false` are false.
 * - `isObject` excludes arrays; use {@link isObjectOrArray} for both.
 * - `isIterable` treats strings as iterable.
 * - `isPromise`/`isPromiseLike` are structural checks (then/catch), not `instanceof`.
 * - `isTupleOf` and `isTupleOfAtLeast` only check length, not element types.
 *
 * **Example** (Filter by a predicate)
 *
 * ```ts
 * import * as Predicate from "effect/Predicate"
 *
 * const isPositive = (n: number) => n > 0
 * const data = [2, -1, 3]
 *
 * console.log(data.filter(isPositive))
 * ```
 *
 * See also: {@link Predicate}, {@link Refinement}, {@link and}, {@link or}, {@link mapInput}
 *
 * @since 2.0.0
 */
export * as Predicate from "./Predicate.ts"

/**
 * This module provides functionality for working with primary keys.
 * A `PrimaryKey` is a simple interface that represents a unique identifier
 * that can be converted to a string representation.
 *
 * Primary keys are useful for creating unique identifiers for objects,
 * database records, cache keys, or any scenario where you need a
 * string-based unique identifier.
 *
 * @since 2.0.0
 */
export * as PrimaryKey from "./PrimaryKey.ts"

/**
 * This module provides utilities for working with publish-subscribe (PubSub) systems.
 *
 * A PubSub is an asynchronous message hub where publishers can publish messages and subscribers
 * can subscribe to receive those messages. PubSub supports various backpressure strategies,
 * message replay, and concurrent access from multiple producers and consumers.
 *
 * @example
 * ```ts
 * import { Effect, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pubsub = yield* PubSub.bounded<string>(10)
 *
 *   // Publisher
 *   yield* PubSub.publish(pubsub, "Hello")
 *   yield* PubSub.publish(pubsub, "World")
 *
 *   // Subscriber
 *   yield* Effect.scoped(Effect.gen(function*() {
 *     const subscription = yield* PubSub.subscribe(pubsub)
 *     const message1 = yield* PubSub.take(subscription)
 *     const message2 = yield* PubSub.take(subscription)
 *     console.log(message1, message2) // "Hello", "World"
 *   }))
 * })
 * ```
 *
 * @since 2.0.0
 */
export * as PubSub from "./PubSub.ts"

/**
 * @since 4.0.0
 */
export * as Pull from "./Pull.ts"

/**
 * @since 3.8.0
 */
export * as Queue from "./Queue.ts"

/**
 * The Random module provides a service for generating random numbers in Effect
 * programs. It offers a testable and composable way to work with randomness,
 * supporting integers, floating-point numbers, and range-based generation.
 *
 * @example
 * ```ts
 * import { Effect, Random } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const randomFloat = yield* Random.next
 *   console.log("Random float:", randomFloat)
 *
 *   const randomInt = yield* Random.nextInt
 *   console.log("Random integer:", randomInt)
 *
 *   const diceRoll = yield* Random.nextIntBetween(1, 6)
 *   console.log("Dice roll:", diceRoll)
 * })
 * ```
 *
 * @since 4.0.0
 */
export * as Random from "./Random.ts"

/**
 * @since 3.5.0
 */
export * as RcMap from "./RcMap.ts"

/**
 * @since 3.5.0
 */
export * as RcRef from "./RcRef.ts"

/**
 * This module provides utility functions for working with records in TypeScript.
 *
 * @since 2.0.0
 */
export * as Record from "./Record.ts"

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
export * as Redactable from "./Redactable.ts"

/**
 * The Redacted module provides functionality for handling sensitive information
 * securely within your application. By using the `Redacted` data type, you can
 * ensure that sensitive values are not accidentally exposed in logs or error
 * messages.
 *
 * @since 3.3.0
 */
export * as Redacted from "./Redacted.ts"

/**
 * A module for reducing collections of values into a single result.
 *
 * A `Reducer<A>` extends {@link Combiner.Combiner} by adding an
 * `initialValue` (identity element) and a `combineAll` method that folds an
 * entire collection. Think `Array.prototype.reduce`, but packaged as a
 * reusable, composable value.
 *
 * ## Mental model
 *
 * - **Reducer** – a {@link Combiner.Combiner} plus an `initialValue` and a
 *   `combineAll` method.
 * - **initialValue** – the neutral/identity element. Combining any value with
 *   `initialValue` should return the original value unchanged (e.g. `0` for
 *   addition, `""` for string concatenation).
 * - **combineAll** – folds an `Iterable<A>` starting from `initialValue`.
 *   When omitted from {@link make}, a default left-to-right fold is used.
 * - **Purity** – all reducers produced by this module are pure; they never
 *   mutate their arguments.
 * - **Composability** – reducers can be lifted into `Option`, `Struct`,
 *   `Tuple`, `Record`, and other container types via helpers in those modules.
 * - **Subtype of Combiner** – every `Reducer` is also a valid
 *   `Combiner`, so you can pass a `Reducer` anywhere a `Combiner` is
 *   expected.
 *
 * ## Common tasks
 *
 * - Create a reducer from a combine function and initial value → {@link make}
 * - Swap argument order → {@link flip}
 * - Combine two values without an initial value → use {@link Combiner.Combiner}
 *   instead
 *
 * ## Gotchas
 *
 * - `combineAll` on an empty iterable returns `initialValue`, not an error.
 * - The default `combineAll` folds left-to-right. If your `combine` is not
 *   associative, order matters. Pass a custom `combineAll` to {@link make} if
 *   you need different traversal or short-circuiting.
 * - A `Reducer` is also a valid `Combiner` — but a `Combiner` is *not* a
 *   `Reducer` (it lacks `initialValue`).
 *
 * ## Quickstart
 *
 * **Example** (summing a list of numbers)
 *
 * ```ts
 * import { Reducer } from "effect"
 *
 * const Sum = Reducer.make<number>((a, b) => a + b, 0)
 *
 * console.log(Sum.combine(3, 4))
 * // Output: 7
 *
 * console.log(Sum.combineAll([1, 2, 3, 4]))
 * // Output: 10
 *
 * console.log(Sum.combineAll([]))
 * // Output: 0
 * ```
 *
 * ## See also
 *
 * - {@link make} – the primary constructor
 * - {@link Reducer} – the core interface
 * - {@link Combiner.Combiner} – the parent interface (no `initialValue`)
 *
 * @since 4.0.0
 */
export * as Reducer from "./Reducer.ts"

/**
 * This module provides utilities for working with mutable references in a functional context.
 *
 * A Ref is a mutable reference that can be read, written, and atomically modified. Unlike plain
 * mutable variables, Refs are thread-safe and work seamlessly with Effect's concurrency model.
 * They provide atomic operations for safe state management in concurrent programs.
 *
 * @example
 * ```ts
 * import { Effect, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create a ref with initial value
 *   const counter = yield* Ref.make(0)
 *
 *   // Atomic operations
 *   yield* Ref.update(counter, (n) => n + 1)
 *   yield* Ref.update(counter, (n) => n * 2)
 *
 *   const value = yield* Ref.get(counter)
 *   console.log(value) // 2
 *
 *   // Atomic modify with return value
 *   const previous = yield* Ref.getAndSet(counter, 100)
 *   console.log(previous) // 2
 * })
 * ```
 *
 * @since 2.0.0
 */
export * as Ref from "./Ref.ts"

/**
 * This module provides a collection of reference implementations for commonly used
 * Effect runtime configuration values. These references allow you to access and
 * modify runtime behavior such as concurrency limits, scheduling policies,
 * tracing configuration, and logging settings.
 *
 * References are special service instances that can be dynamically updated
 * during runtime, making them ideal for configuration that may need to change
 * based on application state or external conditions.
 *
 * @since 4.0.0
 */
export * as References from "./References.ts"

/**
 * This module provides utility functions for working with RegExp in TypeScript.
 *
 * @since 2.0.0
 */
export * as RegExp from "./RegExp.ts"

/**
 * The `Request` module provides a way to model requests to external data sources
 * in a functional and composable manner. Requests represent descriptions of
 * operations that can be batched, cached, and executed efficiently.
 *
 * A `Request<A, E, R>` represents a request that:
 * - Yields a value of type `A` on success
 * - Can fail with an error of type `E`
 * - Requires services of type `R`
 *
 * Requests are primarily used with RequestResolver to implement efficient
 * data fetching patterns, including automatic batching and caching.
 *
 * @since 2.0.0
 */
export * as Request from "./Request.ts"

/**
 * @since 2.0.0
 */
export * as RequestResolver from "./RequestResolver.ts"

/**
 * @since 2.0.0
 */
export * as Resource from "./Resource.ts"

/**
 * A synchronous, pure type for representing computations that can succeed
 * (`Success<A>`) or fail (`Failure<E>`). Unlike `Effect`, `Result` is
 * evaluated eagerly and carries no side effects.
 *
 * **Mental model**
 *
 * - `Result<A, E>` is a discriminated union: `Success<A, E> | Failure<A, E>`
 * - `Success` wraps a value of type `A`, accessed via `.success`
 * - `Failure` wraps an error of type `E`, accessed via `.failure`
 * - `Result` is a monad: chain operations with {@link flatMap}, compose pipelines with `pipe`
 * - All operations are pure and return new `Result` values; the input is never mutated
 * - `Result` is yieldable in `Effect.gen`, producing the inner value or short-circuiting on failure
 *
 * **Common tasks**
 *
 * - Create from a value: {@link succeed}, {@link fail}
 * - Create from nullable: {@link fromNullishOr}
 * - Create from Option: {@link fromOption}
 * - Create from throwing code: {@link try_ try}
 * - Create from predicate: {@link liftPredicate}
 * - Transform: {@link map}, {@link mapError}, {@link mapBoth}
 * - Unwrap: {@link getOrElse}, {@link getOrNull}, {@link getOrUndefined}, {@link getOrThrow}
 * - Pattern match: {@link match}
 * - Sequence: {@link flatMap}, {@link andThen}, {@link all}
 * - Recover: {@link orElse}
 * - Filter: {@link filterOrFail}
 * - Convert to Option: {@link getSuccess}, {@link getFailure}
 * - Generator syntax: {@link gen}
 * - Do notation: {@link Do}, {@link bind}, {@link let_ let}
 * - Check variant: {@link isResult}, {@link isSuccess}, {@link isFailure}
 *
 * **Gotchas**
 *
 * - `E` defaults to `never`, so `Result<number>` means a result that cannot fail
 * - {@link andThen} accepts a `Result`, a function returning a `Result`, a plain value, or a function returning a plain value; {@link flatMap} only accepts a function returning a `Result`
 * - {@link all} short-circuits on the first `Failure` and returns it; later elements are not inspected
 * - {@link getOrThrow} throws the raw failure value `E`; use {@link getOrThrowWith} for custom error objects
 * - {@link tap} runs a side-effect but does not change the result; its return value is ignored
 *
 * **Quickstart**
 *
 * **Example** (Parsing and validating with Result)
 *
 * ```ts
 * import { Result } from "effect"
 *
 * const parse = (input: string): Result.Result<number, string> =>
 *   isNaN(Number(input))
 *     ? Result.fail("not a number")
 *     : Result.succeed(Number(input))
 *
 * const ensurePositive = (n: number): Result.Result<number, string> =>
 *   n > 0 ? Result.succeed(n) : Result.fail("not positive")
 *
 * const result = Result.flatMap(parse("42"), ensurePositive)
 *
 * console.log(Result.getOrElse(result, (err) => `Error: ${err}`))
 * // Output: 42
 * ```
 *
 * **See also**
 *
 * - {@link succeed} / {@link fail} to create values
 * - {@link match} to fold both branches
 * - {@link gen} for generator-based composition
 *
 * @since 4.0.0
 */
export * as Result from "./Result.ts"

/**
 * This module provides utilities for running Effect programs and managing their execution lifecycle.
 *
 * The Runtime module contains functions for creating main program runners that handle process
 * teardown, error reporting, and exit code management. These utilities are particularly useful
 * for creating CLI applications and server processes that need to manage their lifecycle properly.
 *
 * @example
 * ```ts
 * import { Effect, Fiber, Runtime } from "effect"
 *
 * // Create a main runner for Node.js
 * const runMain = Runtime.makeRunMain((options) => {
 *   process.on("SIGINT", () => Effect.runFork(Fiber.interrupt(options.fiber)))
 *   process.on("SIGTERM", () => Effect.runFork(Fiber.interrupt(options.fiber)))
 *
 *   options.fiber.addObserver((exit) => {
 *     options.teardown(exit, (code) => process.exit(code))
 *   })
 * })
 *
 * // Use the runner
 * const program = Effect.log("Hello, World!")
 * runMain(program)
 * ```
 *
 * @since 4.0.0
 */
export * as Runtime from "./Runtime.ts"

/**
 * This module provides utilities for creating and composing schedules for retrying operations,
 * repeating effects, and implementing various timing strategies.
 *
 * A Schedule is a function that takes an input and returns a decision whether to continue or halt,
 * along with a delay duration. Schedules can be combined, transformed, and used to implement
 * sophisticated retry and repetition logic.
 *
 * @example
 * ```ts
 * import { Effect, Schedule } from "effect"
 *
 * // Retry with exponential backoff
 * const retryPolicy = Schedule.exponential("100 millis", 2.0)
 *   .pipe(Schedule.both(Schedule.recurs(3)))
 *
 * const program = Effect.gen(function*() {
 *   // This will retry up to 3 times with exponential backoff
 *   const result = yield* Effect.retry(
 *     Effect.fail("Network error"),
 *     retryPolicy
 *   )
 * })
 *
 * // Repeat on a fixed schedule
 * const heartbeat = Effect.log("heartbeat")
 *   .pipe(Effect.repeat(Schedule.spaced("30 seconds")))
 * ```
 *
 * @since 2.0.0
 */
export * as Schedule from "./Schedule.ts"

/**
 * @since 2.0.0
 */
export * as Scheduler from "./Scheduler.ts"

/**
 * Define data shapes, validate unknown input, and transform values between formats.
 *
 * ## Mental model
 *
 * - **Schema** — a description of a data shape. Every schema carries a decoded
 *   *Type* (the value you work with) and an *Encoded* representation (the
 *   serialized form, e.g. JSON).
 * - **Decoding** — turning unknown external data (API responses, form
 *   submissions, config files) into typed, validated values.
 * - **Encoding** — turning typed values back into a serializable format.
 * - **Codec** — a schema that tracks both Type and Encoded, so it can decode
 *   *and* encode. Most concrete schemas are Codecs.
 * - **Check / Filter** — a constraint attached to a schema (e.g. `isMinLength`,
 *   `isGreaterThan`). Attach them with `.check(...)`.
 * - **Transformation** — a pair of functions (decode + encode) that convert
 *   values between two schemas. Created with {@link decodeTo} / {@link encodeTo}.
 * - **Annotation** — metadata attached to a schema (title, description, custom
 *   keys). Attach with `.annotate(...)`.
 *
 * ## Common tasks
 *
 * - Define a struct: {@link Struct}
 * - Define a union: {@link Union}, {@link TaggedUnion}, {@link Literals}
 * - Define an array: {@link ArraySchema}, {@link NonEmptyArray}
 * - Define a record: {@link Record}
 * - Define a tuple: {@link Tuple}, {@link TupleWithRest}
 * - Validate unknown data synchronously: {@link decodeUnknownSync}
 * - Validate unknown data (Effect): {@link decodeUnknownEffect}
 * - Encode a value: {@link encodeUnknownSync}, {@link encodeUnknownEffect}
 * - Type guard: {@link is}
 * - Assertion: {@link asserts}
 * - Add constraints: `.check(...)` with filters like {@link isMinLength},
 *   {@link isGreaterThan}, {@link isPattern}, {@link isUUID}
 * - Transform between schemas: {@link decodeTo}, {@link encodeTo}
 * - Add a default for missing keys: {@link withDecodingDefault}, {@link withDecodingDefaultKey}
 * - Create branded types: {@link brand}
 * - Define classes with validation: {@link Class}, {@link TaggedClass}
 * - Define error classes: {@link ErrorClass}, {@link TaggedErrorClass}
 * - Generate JSON Schema: {@link toJsonSchemaDocument}
 * - Generate test data: {@link toArbitrary}
 * - Derive equivalence: {@link toEquivalence}
 *
 * ## Gotchas
 *
 * - `Schema.optional` creates `T | undefined` (key can be missing *or*
 *   `undefined`). Use `Schema.optionalKey` for exact optional properties.
 * - `decodeTo` is curried: use `from.pipe(Schema.decodeTo(to, ...))`.
 * - `decodeUnknownSync` throws on failure. Use `decodeUnknownExit` or
 *   `decodeUnknownOption` for non-throwing alternatives.
 * - Filters do not change the TypeScript type. Use {@link refine} or
 *   {@link brand} to narrow the type.
 * - Recursive schemas require {@link suspend} to avoid infinite loops.
 *
 * ## Quickstart
 *
 * **Example** (Validate a user object)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const User = Schema.Struct({
 *   name: Schema.String.check(Schema.isMinLength(1)),
 *   age: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
 *   email: Schema.optionalKey(Schema.String)
 * })
 *
 * // Decode unknown input — throws on failure
 * const user = Schema.decodeUnknownSync(User)({
 *   name: "Alice",
 *   age: 30
 * })
 *
 * console.log(user)
 * // { name: "Alice", age: 30 }
 * ```
 *
 * @see {@link Schema} — type-level view tracking only the decoded Type
 * @see {@link Codec} — type-level view tracking both Type and Encoded
 * @see {@link Struct} — define object shapes
 * @see {@link decodeUnknownSync} — synchronous validation
 * @see {@link decodeTo} — schema transformations
 *
 * @since 4.0.0
 */
export * as Schema from "./Schema.ts"

/**
 * Abstract Syntax Tree (AST) representation for Effect schemas.
 *
 * This module defines the runtime data structures that represent schemas.
 * Most users work with the `Schema` module directly; use `SchemaAST` when you
 * need to inspect, traverse, or programmatically transform schema definitions.
 *
 * ## Mental model
 *
 * - **{@link AST}** — discriminated union (`_tag`) of all schema node types
 *   (e.g. `String`, `Objects`, `Union`, `Suspend`)
 * - **{@link Base}** — abstract base class shared by every node; carries
 *   annotations, checks, encoding chain, and context
 * - **{@link Encoding}** — a non-empty chain of {@link Link} values describing
 *   how to transform between the decoded (type) and encoded (wire) form
 * - **{@link Check}** — a validation filter ({@link Filter} or
 *   {@link FilterGroup}) attached to an AST node
 * - **{@link Context}** — per-property metadata: optionality, mutability,
 *   default values, key annotations
 * - **Guards** — type-narrowing predicates for each AST variant (e.g.
 *   {@link isString}, {@link isObjects})
 *
 * ## Common tasks
 *
 * - Inspect what kind of schema you have → guard functions ({@link isString},
 *   {@link isObjects}, {@link isUnion}, etc.)
 * - Get the decoded (type-level) AST → {@link toType}
 * - Get the encoded (wire-format) AST → {@link toEncoded}
 * - Swap decode/encode directions → {@link flip}
 * - Read annotations → {@link resolve}, {@link resolveAt},
 *   {@link resolveIdentifier}
 * - Build a transformation between schemas → {@link decodeTo}
 * - Add regex validation → {@link isPattern}
 *
 * ## Gotchas
 *
 * - AST nodes are structurally immutable; modification helpers return new
 *   objects via `Object.create`.
 * - {@link Arrays} represents both tuples and arrays; {@link Objects}
 *   represents both structs and records.
 * - {@link toType} and {@link toEncoded} are memoized — same input yields
 *   same output reference.
 * - {@link Suspend} lazily resolves its inner AST via a thunk; the thunk is
 *   memoized on first call.
 *
 * ## Quickstart
 *
 * **Example** (Inspecting a schema's AST)
 *
 * ```ts
 * import { Schema, SchemaAST } from "effect"
 *
 * const schema = Schema.Struct({ name: Schema.String, age: Schema.Number })
 * const ast = schema.ast
 *
 * if (SchemaAST.isObjects(ast)) {
 *   console.log(ast.propertySignatures.map(ps => ps.name))
 *   // ["name", "age"]
 * }
 *
 * const encoded = SchemaAST.toEncoded(ast)
 * console.log(SchemaAST.isObjects(encoded)) // true
 * ```
 *
 * ## See also
 *
 * - {@link AST}
 * - {@link toType}
 * - {@link toEncoded}
 * - {@link flip}
 * - {@link resolve}
 *
 * @since 4.0.0
 */
export * as SchemaAST from "./SchemaAST.ts"

/**
 * Composable transformation primitives for the Effect Schema system.
 *
 * A `Getter<T, E, R>` represents a single-direction transformation from an
 * encoded type `E` to a decoded type `T`. Getters are the building blocks
 * that `Schema.decodeTo` and `Schema.decode` use to define how values are
 * transformed during encoding and decoding. They handle optionality
 * (`Option<E>` in, `Option<T>` out), can fail with `Issue`, and can require
 * Effect services via `R`.
 *
 * ## Mental model
 *
 * - **Getter**: A function `Option<E> -> Effect<Option<T>, Issue, R>`. It
 *   transforms an optional encoded value into an optional decoded value,
 *   possibly failing or requiring services.
 * - **Passthrough**: The identity getter — returns the input unchanged. Used
 *   when no transformation is needed. Optimized away during composition.
 * - **Option-awareness**: Getters receive and return `Option` to handle
 *   missing keys in structs. `Option.None` means the key is absent.
 * - **Composition**: Getters compose left-to-right via `.compose()`. A
 *   passthrough on either side is a no-op (identity optimization).
 * - **Issue**: The error type for all getter failures (see `SchemaIssue`).
 *
 * ## Common tasks
 *
 * - Pass a value through unchanged → {@link passthrough}
 * - Transform a value purely → {@link transform}
 * - Transform a value with possible failure → {@link transformOrFail}
 * - Transform with full Option control → {@link transformOptional}
 * - Handle missing keys → {@link onNone}, {@link required}, {@link withDefault}
 * - Handle present values → {@link onSome}
 * - Validate a value with an effectful check → {@link checkEffect}
 * - Produce a constant value → {@link succeed}
 * - Always fail → {@link fail}, {@link forbidden}
 * - Omit a value from output → {@link omit}
 * - Coerce to a primitive type → {@link String}, {@link Number}, {@link Boolean}, {@link BigInt}, {@link Date}
 * - Transform strings → {@link trim}, {@link capitalize}, {@link toLowerCase}, {@link toUpperCase}, {@link split}, {@link splitKeyValue}, {@link joinKeyValue}
 * - Parse/stringify JSON → {@link parseJson}, {@link stringifyJson}
 * - Encode/decode Base64 → {@link encodeBase64}, {@link decodeBase64}, {@link decodeBase64String}
 * - Encode/decode Hex → {@link encodeHex}, {@link decodeHex}, {@link decodeHexString}
 * - Encode/decode URI components → {@link encodeUriComponent}, {@link decodeUriComponent}
 * - Parse DateTime → {@link dateTimeUtcFromInput}
 * - Decode/encode FormData → {@link decodeFormData}, {@link encodeFormData}
 * - Decode/encode URLSearchParams → {@link decodeURLSearchParams}, {@link encodeURLSearchParams}
 * - Build nested tree from bracket paths → {@link makeTreeRecord}
 * - Flatten nested tree to bracket paths → {@link collectBracketPathEntries}
 *
 * ## Gotchas
 *
 * - Getters are not bidirectional. To define a full encode/decode pair, supply
 *   both a `decode` and an `encode` getter to `Schema.decodeTo`.
 * - `passthrough` requires `T === E` by default. Use `{ strict: false }` to
 *   bypass the type constraint, or use {@link passthroughSupertype} / {@link passthroughSubtype}.
 * - `transform` skips `None` inputs (missing keys) — the function is only
 *   called when a value is present. Use `transformOptional` if you need to
 *   handle missing values.
 * - `parseJson` without a `reviver` returns `Schema.MutableJson`. With a
 *   reviver, the return type widens to `unknown`.
 * - `split` treats an empty string as an empty array, not `[""]`.
 *
 * ## Quickstart
 *
 * **Example** (Using SchemaGetter with Schema.decodeTo)
 *
 * ```ts
 * import { Schema, SchemaGetter } from "effect"
 *
 * const NumberFromString = Schema.String.pipe(
 *   Schema.decodeTo(Schema.Number, {
 *     decode: SchemaGetter.transform((s) => Number(s)),
 *     encode: SchemaGetter.transform((n) => String(n))
 *   })
 * )
 *
 * const result = Schema.decodeUnknownSync(NumberFromString)("42")
 * // result: 42
 * ```
 *
 * ## See also
 *
 * - {@link Getter} — the core class
 * - {@link transform} — most common constructor
 * - {@link passthrough} — identity getter
 * - {@link transformOrFail} — fallible transformation
 *
 * @since 4.0.0
 */
export * as SchemaGetter from "./SchemaGetter.ts"

/**
 * Structured validation errors produced by the Effect Schema system.
 *
 * When `Schema.decode`, `Schema.encode`, or a filter rejects a value, the
 * result is an {@link Issue} — a recursive tree that describes *what* went
 * wrong and *where*. This module defines every node type in that tree and
 * provides formatters that turn an `Issue` into a human-readable string or a
 * Standard Schema V1 failure result.
 *
 * ## Mental model
 *
 * - **Issue**: A discriminated union (`_tag`) of all possible validation error
 *   nodes. It is recursive — composite nodes wrap inner `Issue` children.
 * - **Leaf**: A terminal issue with no inner children ({@link InvalidType},
 *   {@link InvalidValue}, {@link MissingKey}, {@link UnexpectedKey},
 *   {@link Forbidden}, {@link OneOf}).
 * - **Composite nodes**: Wrap one or more inner issues to add context —
 *   {@link Filter}, {@link Encoding}, {@link Pointer}, {@link Composite},
 *   {@link AnyOf}.
 * - **Pointer**: Adds a property-key path to an inner issue, indicating
 *   *where* in the input the error occurred.
 * - **Formatter**: A function `Issue → Format` that serialises the error tree.
 *   Two built-in factories are provided: {@link makeFormatterDefault} (plain
 *   string) and {@link makeFormatterStandardSchemaV1} (Standard Schema V1).
 *
 * ## Common tasks
 *
 * - Check if a value is an Issue → {@link isIssue}
 * - Extract the actual input from any issue → {@link getActual}
 * - Format an issue as a string → {@link makeFormatterDefault}
 * - Format an issue for Standard Schema V1 → {@link makeFormatterStandardSchemaV1}
 * - Customise leaf formatting → {@link defaultLeafHook}
 * - Customise filter formatting → {@link defaultCheckHook}
 *
 * ## Gotchas
 *
 * - `Pointer` and `MissingKey` carry no actual value — {@link getActual}
 *   returns `Option.none()` for them.
 * - `AnyOf`, `UnexpectedKey`, `OneOf`, and `Filter` store `actual` as a plain
 *   `unknown` (not `Option`), so {@link getActual} wraps them with
 *   `Option.some`.
 * - Calling `toString()` on any `Issue` uses the default formatter. To
 *   customise output, create your own formatter with
 *   {@link makeFormatterDefault} or {@link makeFormatterStandardSchemaV1}.
 * - The `Issue` tree can be deeply nested for complex schemas. Formatters
 *   flatten composite nodes for display.
 *
 * ## Quickstart
 *
 * **Example** (Inspecting a validation error)
 *
 * ```ts
 * import { Schema, SchemaIssue } from "effect"
 *
 * const Person = Schema.Struct({
 *   name: Schema.String,
 *   age: Schema.Number
 * })
 *
 * try {
 *   Schema.decodeUnknownSync(Person)({ name: 42 })
 * } catch (e) {
 *   if (Schema.isSchemaError(e)) {
 *     console.log(SchemaIssue.isIssue(e.issue))
 *     // true
 *     console.log(String(e.issue))
 *     // formatted error message
 *   }
 * }
 * ```
 *
 * ## See also
 *
 * - {@link Issue} — the root union type
 * - {@link Leaf} — terminal issue types
 * - {@link Formatter} — the formatter interface
 * - {@link makeFormatterDefault} — default string formatter
 *
 * @since 4.0.0
 */
export * as SchemaIssue from "./SchemaIssue.ts"

/**
 * @since 4.0.0
 */
export * as SchemaParser from "./SchemaParser.ts"

/**
 * Serializable intermediate representation (IR) of Effect Schema types.
 *
 * `SchemaRepresentation` sits between the internal `SchemaAST` and external
 * formats (JSON Schema, generated TypeScript code, serialized JSON). A
 * {@link Representation} is a discriminated union describing the *shape* of a
 * schema — its types, checks, annotations, and references — in a form that
 * can be round-tripped through JSON and used for code generation.
 *
 * ## Mental model
 *
 * - **Representation**: A tagged union (`_tag`) of all supported schema shapes:
 *   primitives, literals, objects, arrays, unions, declarations, references,
 *   and suspensions.
 * - **Document**: A single {@link Representation} paired with a map of named
 *   {@link References} (analogous to JSON Schema `$defs`).
 * - **MultiDocument**: Like `Document` but holds one or more representations
 *   sharing the same references.
 * - **Check / Filter / FilterGroup**: Validation constraints (min length,
 *   pattern, integer, etc.) attached to types that support them.
 * - **Meta types**: Typed metadata for checks on each category — e.g.
 *   {@link StringMeta}, {@link NumberMeta}, {@link ArraysMeta}.
 * - **Reviver**: A callback used by {@link toSchema} and {@link toCodeDocument}
 *   to handle `Declaration` nodes (custom types like `Option`, `Date`, etc.).
 * - **Code / CodeDocument**: Output of {@link toCodeDocument} — TypeScript
 *   source strings for runtime schemas and their type-level counterparts.
 *
 * ## Common tasks
 *
 * - Convert a Schema AST to a Document → {@link fromAST}
 * - Convert multiple ASTs to a MultiDocument → {@link fromASTs}
 * - Reconstruct a runtime Schema from a Document → {@link toSchema}
 * - Convert a Document to JSON Schema → {@link toJsonSchemaDocument}
 * - Convert a MultiDocument to JSON Schema → {@link toJsonSchemaMultiDocument}
 * - Parse a JSON Schema document into a Document → {@link fromJsonSchemaDocument}
 * - Parse a JSON Schema multi-document → {@link fromJsonSchemaMultiDocument}
 * - Generate TypeScript code from a MultiDocument → {@link toCodeDocument}
 * - Serialize/deserialize a Document as JSON → {@link DocumentFromJson}
 * - Serialize/deserialize a MultiDocument as JSON → {@link MultiDocumentFromJson}
 * - Wrap a Document as a MultiDocument → {@link toMultiDocument}
 *
 * ## Gotchas
 *
 * - `Declaration` nodes require a {@link Reviver} to reconstruct complex types
 *   (e.g. `Option`, `Date`). Without one, `toSchema` falls back to the
 *   declaration's `encodedSchema`. Use {@link toSchemaDefaultReviver} for
 *   built-in Effect types.
 * - `Reference` nodes are resolved against the `references` map in the
 *   `Document`. An unresolvable `$ref` throws at runtime.
 * - `Suspend` wraps a single `thunk` representation; it is used for recursive
 *   schemas. Circular references are handled by lazy resolution in
 *   {@link toSchema}.
 * - The `$`-prefixed exports (e.g. {@link $Representation}, {@link $Document})
 *   are Schema codecs for the representation types themselves — use them to
 *   validate or encode/decode representation data, not application data.
 *
 * ## Quickstart
 *
 * **Example** (Round-trip through JSON)
 *
 * ```ts
 * import { Schema, SchemaRepresentation } from "effect"
 *
 * const Person = Schema.Struct({
 *   name: Schema.String,
 *   age: Schema.Int
 * })
 *
 * // Schema AST → Document
 * const doc = SchemaRepresentation.fromAST(Person.ast)
 *
 * // Document → JSON Schema
 * const jsonSchema = SchemaRepresentation.toJsonSchemaDocument(doc)
 *
 * // Document → runtime Schema
 * const reconstructed = SchemaRepresentation.toSchema(doc)
 * ```
 *
 * ## See also
 *
 * - {@link Representation} — the core tagged union
 * - {@link Document} — single-schema container
 * - {@link fromAST} — entry point from Schema AST
 * - {@link toSchema} — reconstruct a runtime Schema
 * - {@link toCodeDocument} — generate TypeScript code
 *
 * @since 4.0.0
 */
export * as SchemaRepresentation from "./SchemaRepresentation.ts"

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
 * - Coerce string ↔ Date → {@link dateFromString}
 * - Decode durations → {@link durationFromNanos}, {@link durationFromMillis}
 * - Wrap nullable/optional as Option → {@link optionFromNullOr}, {@link optionFromOptionalKey}, {@link optionFromOptional}
 * - Parse URLs → {@link urlFromString}
 * - Base64 ↔ Uint8Array → {@link uint8ArrayFromBase64String}
 * - Base64 ↔ string → {@link stringFromBase64String}
 * - URI component ↔ string → {@link stringFromUriComponent}
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
export * as SchemaTransformation from "./SchemaTransformation.ts"

/**
 * @since 4.0.0
 */
export * as SchemaUtils from "./SchemaUtils.ts"

/**
 * The `Scope` module provides functionality for managing resource lifecycles
 * and cleanup operations in a functional and composable manner.
 *
 * A `Scope` represents a context where resources can be acquired and automatically
 * cleaned up when the scope is closed. This is essential for managing resources
 * like file handles, database connections, or any other resources that need
 * proper cleanup.
 *
 * Scopes support both sequential and parallel finalization strategies:
 * - Sequential: Finalizers run one after another in reverse order of registration
 * - Parallel: Finalizers run concurrently for better performance
 *
 * @since 2.0.0
 */
export * as Scope from "./Scope.ts"

/**
 * @since 4.0.0
 */
export * as ScopedCache from "./ScopedCache.ts"

/**
 * @since 2.0.0
 */
export * as ScopedRef from "./ScopedRef.ts"

/**
 * @since 2.0.0
 */
export * as Semaphore from "./Semaphore.ts"

/**
 * @since 2.0.0
 */
export * as Sink from "./Sink.ts"

/**
 * @since 4.0.0
 */
export * as Stdio from "./Stdio.ts"

/**
 * @since 2.0.0
 */
export * as Stream from "./Stream.ts"

/**
 * This module provides utility functions and type class instances for working with the `string` type in TypeScript.
 * It includes functions for basic string manipulation.
 *
 * @since 2.0.0
 */
export * as String from "./String.ts"

/**
 * Utilities for creating, transforming, and comparing plain TypeScript objects
 * (structs). Every function produces a new object — inputs are never mutated.
 *
 * ## Mental model
 *
 * - **Struct**: A plain JS object with a fixed set of known keys (e.g.,
 *   `{ name: string; age: number }`). Not a generic key-value record.
 * - **Dual API**: Most functions accept arguments in both data-first
 *   (`Struct.pick(obj, keys)`) and data-last (`pipe(obj, Struct.pick(keys))`)
 *   style.
 * - **Immutability**: All operations return a new object; the original is
 *   never modified.
 * - **Lambda**: A type-level function interface (`~lambda.in` / `~lambda.out`)
 *   used by {@link map}, {@link mapPick}, and {@link mapOmit} so the compiler
 *   can track how value types change.
 * - **Evolver pattern**: {@link evolve}, {@link evolveKeys}, and
 *   {@link evolveEntries} let you selectively transform values, keys, or both
 *   while leaving untouched properties unchanged.
 *
 * ## Common tasks
 *
 * - Access a property in a pipeline → {@link get}
 * - List string keys with proper types → {@link keys}
 * - Subset / remove properties → {@link pick}, {@link omit}
 * - Merge two structs (second wins) → {@link assign}
 * - Rename keys → {@link renameKeys}
 * - Transform selected values → {@link evolve}
 * - Transform selected keys → {@link evolveKeys}
 * - Transform both keys and values → {@link evolveEntries}
 * - Map all values with a typed lambda → {@link map}, {@link mapPick},
 *   {@link mapOmit}
 * - Compare structs → {@link makeEquivalence}, {@link makeOrder}
 * - Combine / reduce structs → {@link makeCombiner}, {@link makeReducer}
 * - Flatten intersection types → {@link Simplify}
 * - Strip `readonly` modifiers → {@link Mutable}
 *
 * ## Gotchas
 *
 * - {@link keys} only returns `string` keys; symbol keys are excluded.
 * - {@link pick} and {@link omit} iterate with `for...in`, which includes
 *   inherited enumerable properties but excludes non-enumerable ones.
 * - {@link assign} spreads with `...`; property order follows standard
 *   JS spread rules.
 * - {@link map}, {@link mapPick}, {@link mapOmit} require a {@link Lambda}
 *   value created with {@link lambda}; a plain function won't type-check.
 *
 * ## Quickstart
 *
 * **Example** (Picking, renaming, and evolving struct properties)
 *
 * ```ts
 * import { pipe, Struct } from "effect"
 *
 * const user = { firstName: "Alice", lastName: "Smith", age: 30, admin: false }
 *
 * const result = pipe(
 *   user,
 *   Struct.pick(["firstName", "age"]),
 *   Struct.evolve({ age: (n) => n + 1 }),
 *   Struct.renameKeys({ firstName: "name" })
 * )
 *
 * console.log(result) // { name: "Alice", age: 31 }
 * ```
 *
 * ## See also
 *
 * - {@link Equivalence} – building equivalence relations for structs
 * - {@link Order} – ordering structs by their fields
 * - {@link Combiner} – combining two values of the same type
 * - {@link Reducer} – combining with an initial value
 *
 * @since 2.0.0
 */
export * as Struct from "./Struct.ts"

/**
 * @since 2.0.0
 */
export * as SubscriptionRef from "./SubscriptionRef.ts"

/**
 * @since 2.0.0
 */
export * as Symbol from "./Symbol.ts"

/**
 * @since 2.0.0
 */
export * as SynchronizedRef from "./SynchronizedRef.ts"

/**
 * @since 2.0.0
 */
export * as Take from "./Take.ts"

/**
 * @since 4.0.0
 */
export * as Terminal from "./Terminal.ts"

/**
 * @since 2.0.0
 */
export * as Tracer from "./Tracer.ts"

/**
 * A `Trie` is used for locating specific `string` keys from within a set.
 *
 * It works similar to `HashMap`, but with keys required to be `string`.
 * This constraint unlocks some performance optimizations and new methods to get string prefixes (e.g. `keysWithPrefix`, `longestPrefixOf`).
 *
 * Prefix search is also the main feature that makes a `Trie` more suited than `HashMap` for certain usecases.
 *
 * A `Trie` is often used to store a dictionary (list of words) that can be searched
 * in a manner that allows for efficient generation of completion lists
 * (e.g. predict the rest of a word a user is typing).
 *
 * A `Trie` has O(n) lookup time where `n` is the size of the key,
 * or even less than `n` on search misses.
 *
 * @since 2.0.0
 */
export * as Trie from "./Trie.ts"

/**
 * Utilities for creating, accessing, transforming, and comparing fixed-length
 * arrays (tuples). Every function produces a new tuple — inputs are never
 * mutated.
 *
 * ## Mental model
 *
 * - **Tuple**: A fixed-length readonly array where each position can have a
 *   different type (e.g., `readonly [string, number, boolean]`).
 * - **Index-based access**: Elements are accessed by numeric index, and the
 *   type system tracks the type at each position.
 * - **Dual API**: Most functions accept arguments in both data-first
 *   (`Tuple.get(t, 0)`) and data-last (`pipe(t, Tuple.get(0))`) style.
 * - **Immutability**: All operations return a new tuple; the original is
 *   never modified.
 * - **Lambda**: A type-level function interface (from {@link Struct}) used by
 *   {@link map}, {@link mapPick}, and {@link mapOmit} so the compiler can
 *   track how element types change.
 *
 * ## Common tasks
 *
 * - Create a tuple → {@link make}
 * - Access an element by index → {@link get}
 * - Select / remove elements by index → {@link pick}, {@link omit}
 * - Append elements → {@link appendElement}, {@link appendElements}
 * - Transform selected elements → {@link evolve}
 * - Swap element positions → {@link renameIndices}
 * - Map all elements with a typed lambda → {@link map}, {@link mapPick},
 *   {@link mapOmit}
 * - Compare tuples → {@link makeEquivalence}, {@link makeOrder}
 * - Combine / reduce tuples → {@link makeCombiner}, {@link makeReducer}
 * - Check tuple length at runtime → {@link isTupleOf},
 *   {@link isTupleOfAtLeast}
 *
 * ## Gotchas
 *
 * - {@link pick} and {@link omit} use numeric indices, not string keys.
 * - {@link renameIndices} takes an array of stringified source indices
 *   (e.g., `["2", "1", "0"]`), not arbitrary names.
 * - {@link map}, {@link mapPick}, {@link mapOmit} require a Lambda value
 *   created with `Struct.lambda`; a plain function won't type-check.
 * - {@link isTupleOf} and {@link isTupleOfAtLeast} only check length, not
 *   element types.
 *
 * ## Quickstart
 *
 * **Example** (Creating and transforming a tuple)
 *
 * ```ts
 * import { pipe, Tuple } from "effect"
 *
 * const point = Tuple.make(10, 20, "red")
 *
 * const result = pipe(
 *   point,
 *   Tuple.evolve([
 *     (x) => x * 2,
 *     (y) => y * 2
 *   ])
 * )
 *
 * console.log(result) // [20, 40, "red"]
 * ```
 *
 * ## See also
 *
 * - {@link Struct} – similar utilities for objects with named keys
 * - {@link Array} – operations on variable-length arrays
 *
 * @since 2.0.0
 */
export * as Tuple from "./Tuple.ts"

/**
 * TxChunk is a transactional chunk data structure that provides Software Transactional Memory (STM)
 * semantics for chunk operations. It uses a `TxRef<Chunk<A>>` internally to ensure all operations
 * are performed atomically within transactions.
 *
 * Accessed values are tracked by the transaction in order to detect conflicts and to track changes.
 * A transaction will retry whenever a conflict is detected or whenever the transaction explicitly
 * calls `Effect.txRetry` and any of the accessed TxChunk values change.
 *
 * @since 4.0.0
 */
export * as TxChunk from "./TxChunk.ts"

/**
 * A transactional deferred value — a write-once cell that can be read within transactions.
 * Readers retry until a value is set; once set, the value is immutable.
 *
 * @since 4.0.0
 */
export * as TxDeferred from "./TxDeferred.ts"

/**
 * @since 2.0.0
 */
export * as TxHashMap from "./TxHashMap.ts"

/**
 * @since 2.0.0
 */
export * as TxHashSet from "./TxHashSet.ts"

/**
 * A transactional priority queue. Elements are dequeued in order determined by the
 * provided `Order` instance. All operations participate in the STM transaction system.
 *
 * @since 4.0.0
 */
export * as TxPriorityQueue from "./TxPriorityQueue.ts"

/**
 * TxPubSub is a transactional publish/subscribe hub that provides Software Transactional Memory
 * (STM) semantics for message broadcasting. Publishers broadcast messages to all current
 * subscribers, with each subscriber receiving its own copy of every published message.
 *
 * Supports multiple queue strategies: bounded, unbounded, dropping, and sliding.
 *
 * @since 4.0.0
 */
export * as TxPubSub from "./TxPubSub.ts"

/**
 * TxQueue is a transactional queue data structure that provides Software Transactional Memory (STM)
 * semantics for queue operations. It uses TxRef for transactional state management and supports
 * multiple queue strategies: bounded, unbounded, dropping, and sliding.
 *
 * Accessed values are tracked by the transaction in order to detect conflicts and to track changes.
 * A transaction will retry whenever a conflict is detected or whenever the transaction explicitly
 * calls `Effect.txRetry` and any of the accessed TxQueue values change.
 *
 * @since 4.0.0
 */
export * as TxQueue from "./TxQueue.ts"

/**
 * TxReentrantLock is a transactional read/write lock with reentrant semantics using Software
 * Transactional Memory (STM). Multiple readers can hold the lock concurrently, OR a single
 * writer can hold exclusive access. A fiber holding a write lock may acquire additional
 * read or write locks (reentrancy).
 *
 * @since 4.0.0
 */
export * as TxReentrantLock from "./TxReentrantLock.ts"

/**
 * TxRef is a transactional value, it can be read and modified within the body of a transaction.
 *
 * Accessed values are tracked by the transaction in order to detect conflicts and in order to
 * track changes, a transaction will retry whenever a conflict is detected or whenever the
 * transaction explicitely calls to `Effect.txRetry` and any of the accessed TxRef values
 * change.
 *
 * @since 4.0.0
 */
export * as TxRef from "./TxRef.ts"

/**
 * @since 4.0.0
 */
export * as TxSemaphore from "./TxSemaphore.ts"

/**
 * TxSubscriptionRef is a TxRef that allows subscribing to all committed changes. Subscribers
 * receive the current value followed by every subsequent update via a transactional queue.
 *
 * @since 4.0.0
 */
export * as TxSubscriptionRef from "./TxSubscriptionRef.ts"

/**
 * Type-level utility types for TypeScript.
 *
 * This module provides generic type aliases used throughout the Effect
 * ecosystem. Everything here is compile-time only — there are no runtime
 * values. Use these types to manipulate object shapes, tagged unions, tuples,
 * and variance markers at the type level.
 *
 * ## Mental model
 *
 * - **Tagged union**: a union of objects each having a discriminating
 *   `_tag: string` field. {@link Tags}, {@link ExtractTag}, and
 *   {@link ExcludeTag} operate on these.
 * - **Reason**: a nested error pattern where an error has a `reason` field
 *   containing a tagged union of sub-errors. {@link ReasonOf},
 *   {@link ReasonTags}, {@link ExtractReason}, and {@link ExcludeReason} work
 *   with this pattern.
 * - **Variance markers**: {@link Covariant}, {@link Contravariant}, and
 *   {@link Invariant} are function-type aliases encoding variance for phantom
 *   type parameters.
 * - **Simplify**: {@link Simplify} flattens intersection types (`A & B`) into
 *   a single object type for cleaner IDE tooltips.
 * - **Concurrency**: {@link Concurrency} is a union type
 *   (`number | "unbounded" | "inherit"`) used across Effect APIs that accept
 *   concurrency options.
 * - **Marker types**: {@link unassigned} and {@link unhandled} are branded
 *   interfaces used internally to represent missing or unhandled type
 *   parameters.
 *
 * ## Common tasks
 *
 * - Flatten an intersection for readability → {@link Simplify}
 * - Check type equality at compile time → {@link Equals} / {@link EqualsWith}
 * - Merge two object types → {@link MergeLeft} / {@link MergeRight}
 * - Work with tagged unions → {@link Tags} / {@link ExtractTag} / {@link ExcludeTag}
 * - Work with nested reason errors → {@link ReasonOf} / {@link ExtractReason}
 * - Create fixed-length tuples → {@link TupleOf} / {@link TupleOfAtLeast}
 * - Strip `readonly` modifiers → {@link Mutable} / {@link DeepMutable}
 * - Encode variance in phantom types → {@link Covariant} / {@link Contravariant} / {@link Invariant}
 * - Check if a type is a union → {@link IsUnion}
 *
 * ## Gotchas
 *
 * - {@link TupleOf} with a non-literal `number` (e.g. `TupleOf<number, string>`)
 *   degrades to `Array<string>`.
 * - {@link MergeRecord} is an alias for {@link MergeLeft}; prefer
 *   {@link MergeLeft} or {@link MergeRight} for clarity.
 * - {@link NoInfer} uses the `[A][A extends any ? 0 : never]` trick, not the
 *   built-in `NoInfer` from TypeScript 5.4+.
 * - {@link DeepMutable} recurses into `Map`, `Set`, arrays, and objects but
 *   stops at primitives and functions.
 *
 * @since 4.0.0
 */
export * as Types from "./Types.ts"

/**
 * This module provides small, allocation-free utilities for working with values of type
 * `A | undefined`, where `undefined` means "no value".
 *
 * Why not `Option<A>`?
 * In TypeScript, `Option<A>` is often unnecessary. If `undefined` already models absence
 * in your domain, using `A | undefined` keeps types simple, avoids extra wrappers, and
 * reduces overhead. The key is that `A` itself must not include `undefined`; in this
 * module `undefined` is reserved to mean "no value".
 *
 * When to use `A | undefined`:
 * - Absence can be represented by `undefined` in your domain model.
 * - You do not need to distinguish between "no value" and "value is undefined".
 * - You want straightforward ergonomics and zero extra allocations.
 *
 * When to prefer `Option<A>`:
 * - You must distinguish `None` from `Some(undefined)` (that is, `undefined` is a valid
 *   payload and carries meaning on its own).
 * - You need a tagged representation for serialization or pattern matching across
 *   boundaries where `undefined` would be ambiguous.
 * - You want the richer `Option` API and are comfortable with the extra wrapper.
 *
 * Lawfulness note:
 * All helpers treat `undefined` as absence. Do not use these utilities with payloads
 * where `A` can itself be `undefined`, or you will lose information. If you need to
 * carry `undefined` as a valid payload, use `Option<A>` instead.
 *
 * @since 4.0.0
 */
export * as UndefinedOr from "./UndefinedOr.ts"

/**
 * @since 2.0.0
 */
export * as Unify from "./Unify.ts"

/**
 * Internal utilities for the Effect ecosystem's generator-based syntax and
 * higher-kinded type machinery.
 *
 * ## Mental model
 *
 * - **SingleShotGen** — an `IterableIterator` wrapper that yields its value
 *   exactly once. Used internally by `[Symbol.iterator]()` on Effect, Option,
 *   Result, and other yieldable types so they work inside generator functions.
 * - **Gen** — a type-level signature for generator-based monadic composition
 *   (`gen` functions). Parametric over any `TypeLambda` so each module
 *   (Effect, Option, Result, ...) can expose its own `gen` with correct types.
 * - **Variance** — a type-level marker that encodes the variance (covariant,
 *   contravariant, invariant) of a `TypeLambda`'s type parameters.
 *   Used by {@link Gen} for type inference.
 *
 * ## Common tasks
 *
 * - Make a type yieldable in generators -> implement `[Symbol.iterator]()` returning a {@link SingleShotGen}
 * - Define a generator-based API for a new TypeLambda -> type it as {@link Gen}`<MyTypeLambda>`
 * - Encode variance for a higher-kinded type -> use {@link Variance}
 *
 * ## Gotchas
 *
 * - {@link SingleShotGen} yields its value only on the first `.next()` call.
 *   Calling `.next()` again returns `{ done: true }`. Iterating the same
 *   instance twice will skip the value on the second pass; call
 *   `[Symbol.iterator]()` to get a fresh iterator.
 * - {@link Gen} and {@link Variance} are pure type-level constructs — they
 *   have no runtime representation.
 *
 * ## Quickstart
 *
 * **Example** (Using SingleShotGen to make a type yieldable)
 *
 * ```ts
 * import { Utils } from "effect"
 *
 * class MyWrapper<A> {
 *   constructor(readonly value: A) {}
 *   [Symbol.iterator]() {
 *     return new Utils.SingleShotGen<MyWrapper<A>, A>(this)
 *   }
 * }
 *
 * const w = new MyWrapper(42)
 * const iter = w[Symbol.iterator]()
 * console.log(iter.next(undefined as any))
 * // { value: MyWrapper { value: 42 }, done: false }
 * console.log(iter.next(42))
 * // { value: 42, done: true }
 * ```
 *
 * @see {@link SingleShotGen}
 * @see {@link Gen}
 * @see {@link Variance}
 *
 * @since 2.0.0
 */
export * as Utils from "./Utils.ts"
