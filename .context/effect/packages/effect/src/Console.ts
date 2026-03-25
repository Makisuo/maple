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
import type * as Effect from "./Effect.ts"
import { dual } from "./Function.ts"
import * as core from "./internal/core.ts"
import * as effect from "./internal/effect.ts"
import type { Scope } from "./Scope.ts"
import type * as ServiceMap from "./ServiceMap.ts"

/**
 * Represents a console interface for logging and debugging operations.
 *
 * Provides methods for various console operations including logging, debugging,
 * timing, and grouping output.
 *
 * @since 2.0.0
 * @category models
 */
export interface Console {
  assert(condition: boolean, ...args: ReadonlyArray<any>): void
  clear(): void
  count(label?: string): void
  countReset(label?: string): void
  debug(...args: ReadonlyArray<any>): void
  dir(item: any, options?: any): void
  dirxml(...args: ReadonlyArray<any>): void
  error(...args: ReadonlyArray<any>): void
  group(...args: ReadonlyArray<any>): void
  groupCollapsed(...args: ReadonlyArray<any>): void
  groupEnd(): void
  info(...args: ReadonlyArray<any>): void
  log(...args: ReadonlyArray<any>): void
  table(tabularData: any, properties?: ReadonlyArray<string>): void
  time(label?: string): void
  timeEnd(label?: string): void
  timeLog(label?: string, ...args: ReadonlyArray<any>): void
  trace(...args: ReadonlyArray<any>): void
  warn(...args: ReadonlyArray<any>): void
}

/**
 * A reference to the current console service in the Effect system.
 *
 * This reference allows you to access the current console implementation
 * from within the Effect context.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Console.consoleWith((console) =>
 *   Effect.sync(() => {
 *     console.log("Hello from current console!")
 *   })
 * )
 * ```
 *
 * @since 4.0.0
 * @category references
 */
export const Console: ServiceMap.Reference<Console> = effect.ConsoleRef

/**
 * Creates an Effect that provides access to the current console instance.
 *
 * This function allows you to access the console service and perform operations
 * with it within an Effect context.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Console.consoleWith((console) =>
 *   Effect.sync(() => {
 *     console.log("Hello, world!")
 *     console.error("This is an error message")
 *   })
 * )
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const consoleWith = <A, E, R>(f: (console: Console) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  core.withFiber((fiber) => f(fiber.getRef(Console)))

/**
 * Writes an assertion message to the console if the condition is false.
 *
 * If the condition is true, nothing happens. If the condition is false,
 * the message is logged to the console as an error.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.assert(2 + 2 === 4, "Math is working correctly")
 *   yield* Console.assert(2 + 2 === 5, "This will be logged as an error")
 * })
 * ```
 *
 * @since 2.0.0
 * @category accessor
 */
export const assert = (condition: boolean, ...args: ReadonlyArray<any>): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.assert(condition, ...args)
    })
  )

/**
 * Clears the console.
 *
 * This function clears all previously logged messages from the console.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.log("This will be cleared")
 *   yield* Console.clear
 *   yield* Console.log("This appears after clearing")
 * })
 * ```
 *
 * @since 2.0.0
 * @category accessor
 */
export const clear: Effect.Effect<void> = consoleWith((console) =>
  effect.sync(() => {
    console.clear()
  })
)

/**
 * Logs the number of times that this particular call to count has been called.
 *
 * This function maintains a counter for each unique label and increments it
 * each time count is called with that label.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.count("my-counter")
 *   yield* Console.count("my-counter") // Will show: my-counter: 2
 *   yield* Console.count() // Default counter
 * })
 * ```
 *
 * @since 2.0.0
 * @category accessor
 */
export const count = (label?: string): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.count(label)
    })
  )

/**
 * Resets the counter for the given label.
 *
 * This function resets the counter associated with the specified label
 * back to zero.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.count("my-counter")
 *   yield* Console.count("my-counter") // Will show: my-counter: 2
 *   yield* Console.countReset("my-counter")
 *   yield* Console.count("my-counter") // Will show: my-counter: 1
 * })
 * ```
 *
 * @since 2.0.0
 * @category accessor
 */
export const countReset = (label?: string): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.countReset(label)
    })
  )

/**
 * Outputs a debug message to the console.
 *
 * This function logs messages at the debug level, which may be filtered
 * out in production environments.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.debug("Debug info:", { userId: 123, action: "login" })
 *   yield* Console.debug("Processing step", 1, "of", 5)
 * })
 * ```
 *
 * @since 2.0.0
 * @category accessor
 */
export const debug = (...args: ReadonlyArray<any>): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.debug(...args)
    })
  )

/**
 * Displays an interactive list of the properties of the specified object.
 *
 * This function provides a detailed view of an object's properties,
 * which can be useful for debugging complex data structures.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const obj = { name: "John", age: 30, nested: { city: "New York" } }
 *   yield* Console.dir(obj)
 *   yield* Console.dir(obj, { depth: 2, colors: true })
 * })
 * ```
 *
 * @since 2.0.0
 * @category accessor
 */
export const dir = (item: any, options?: any): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.dir(item, options)
    })
  )

/**
 * Displays an interactive tree of the descendant elements of the specified XML/HTML element.
 *
 * This function is particularly useful for inspecting DOM elements in browser environments.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // In a browser environment
 *   const element = document.getElementById("myElement")
 *   yield* Console.dirxml(element)
 * })
 * ```
 *
 * @since 2.0.0
 * @category accessor
 */
export const dirxml = (...args: ReadonlyArray<any>): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.dirxml(...args)
    })
  )

/**
 * Outputs an error message to the console.
 *
 * This function logs messages at the error level, typically displayed
 * in red or with an error icon in most console implementations.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.error("Something went wrong!")
 *   yield* Console.error("Error details:", {
 *     code: 500,
 *     message: "Internal Server Error"
 *   })
 * })
 * ```
 *
 * @since 2.0.0
 * @category accessor
 */
export const error = (...args: ReadonlyArray<any>): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.error(...args)
    })
  )

/**
 * Creates a new inline group in the console and returns a scoped Effect.
 *
 * This function creates a collapsible group of console messages. The group
 * is automatically closed when the Effect's scope is finalized.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.scoped(
 *     Effect.gen(function*() {
 *       yield* Console.group({ label: "User Processing" })
 *       yield* Console.log("Loading user data...")
 *       yield* Console.log("Validating user...")
 *       yield* Console.log("User processed successfully")
 *     })
 *   )
 * })
 * ```
 *
 * @since 2.0.0
 * @category accessor
 */
export const group = (
  options?: { label?: string | undefined; collapsed?: boolean | undefined } | undefined
): Effect.Effect<void, never, Scope> =>
  consoleWith((console) =>
    effect.acquireRelease(
      effect.sync(() => {
        if (options?.collapsed) {
          console.groupCollapsed(options.label)
        } else {
          console.group(options?.label)
        }
      }),
      () =>
        effect.sync(() => {
          console.groupEnd()
        })
    )
  )

/**
 * Outputs an informational message to the console.
 *
 * This function logs messages at the info level, typically displayed
 * with an info icon in most console implementations.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.info("Application started successfully")
 *   yield* Console.info("Server configuration:", {
 *     port: 3000,
 *     env: "development"
 *   })
 * })
 * ```
 *
 * @since 2.0.0
 * @category accessor
 */
export const info = (...args: ReadonlyArray<any>): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.info(...args)
    })
  )

/**
 * Outputs a message to the console.
 *
 * This is the most commonly used console method for general purpose logging.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.log("Hello, world!")
 *   yield* Console.log("User data:", { name: "John", age: 30 })
 *   yield* Console.log("Processing", 42, "items")
 * })
 * ```
 *
 * @since 2.0.0
 * @category accessor
 */
export const log = (...args: ReadonlyArray<any>): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.log(...args)
    })
  )

/**
 * Displays tabular data as a table in the console.
 *
 * This function takes tabular data and displays it in a formatted table,
 * making it easier to read structured data.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const users = [
 *     { name: "John", age: 30, city: "New York" },
 *     { name: "Jane", age: 25, city: "London" },
 *     { name: "Bob", age: 35, city: "Paris" }
 *   ]
 *   yield* Console.table(users)
 *   yield* Console.table(users, ["name", "age"]) // Only show specific columns
 * })
 * ```
 *
 * @since 2.0.0
 * @category accessor
 */
export const table = (tabularData: any, properties?: ReadonlyArray<string>): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.table(tabularData, properties)
    })
  )

/**
 * Starts a timer that can be used to compute the duration of an operation.
 *
 * This function returns a scoped Effect that starts a timer when entered
 * and automatically ends the timer when the scope is finalized.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.scoped(
 *     Effect.gen(function*() {
 *       yield* Console.time("operation-timer")
 *       yield* Effect.sleep("1 second")
 *       yield* Console.log("Operation completed")
 *       // Timer ends automatically when scope closes
 *     })
 *   )
 * })
 * ```
 *
 * @since 2.0.0
 * @category accessor
 */
export const time = (label?: string | undefined): Effect.Effect<void, never, Scope> =>
  consoleWith((console) =>
    effect.acquireRelease(
      effect.sync(() => {
        console.time(label)
      }),
      () =>
        effect.sync(() => {
          console.timeEnd(label)
        })
    )
  )

/**
 * Logs the current value of a timer that was previously started by calling time.
 *
 * This function logs the elapsed time for a timer without stopping it,
 * allowing you to track progress of long-running operations.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.scoped(
 *     Effect.gen(function*() {
 *       yield* Console.time("long-operation")
 *       yield* Effect.sleep("500 millis")
 *       yield* Console.timeLog("long-operation", "Halfway done")
 *       yield* Effect.sleep("500 millis")
 *       // Timer ends when scope closes
 *     })
 *   )
 * })
 * ```
 *
 * @since 2.0.0
 * @category accessor
 */
export const timeLog = (label?: string, ...args: ReadonlyArray<any>): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.timeLog(label, ...args)
    })
  )

/**
 * Outputs a stack trace to the console.
 *
 * This function logs the current stack trace, which is useful for debugging
 * to understand how the current point in the code was reached.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.trace("Debug trace point")
 *   yield* Console.trace("Function call:", { functionName: "processData" })
 * })
 * ```
 *
 * @since 2.0.0
 * @category accessor
 */
export const trace = (...args: ReadonlyArray<any>): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.trace(...args)
    })
  )

/**
 * Outputs a warning message to the console.
 *
 * This function logs messages at the warning level, typically displayed
 * in yellow or with a warning icon in most console implementations.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.warn("This feature is deprecated")
 *   yield* Console.warn("Performance warning:", {
 *     slowQuery: "SELECT * FROM large_table"
 *   })
 * })
 * ```
 *
 * @since 2.0.0
 * @category accessor
 */
export const warn = (...args: ReadonlyArray<any>): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.warn(...args)
    })
  )

/**
 * Wraps an Effect with a console group.
 *
 * This function creates a console group around the execution of an Effect,
 * automatically starting the group before the Effect runs and ending it
 * after the Effect completes.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.withGroup(
 *     Effect.gen(function*() {
 *       yield* Console.log("Step 1: Initialize")
 *       yield* Console.log("Step 2: Process")
 *       yield* Console.log("Step 3: Complete")
 *     }),
 *     { label: "Processing Steps", collapsed: false }
 *   )
 * })
 * ```
 *
 * @since 2.0.0
 * @category accessor
 */
export const withGroup = dual<
  (
    options?: {
      readonly label?: string | undefined
      readonly collapsed?: boolean | undefined
    }
  ) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
    options?: {
      readonly label?: string | undefined
      readonly collapsed?: boolean | undefined
    }
  ) => Effect.Effect<A, E, R>
>((args) => core.isEffect(args[0]), (self, options) =>
  consoleWith((console) =>
    effect.acquireUseRelease(
      effect.sync(() => {
        if (options?.collapsed) {
          console.groupCollapsed(options.label)
        } else {
          console.group(options?.label)
        }
      }),
      () => self,
      () =>
        effect.sync(() => {
          console.groupEnd()
        })
    )
  ))

/**
 * Wraps an Effect with a timer.
 *
 * This function measures the execution time of an Effect, automatically
 * starting a timer before the Effect runs and logging the elapsed time
 * after the Effect completes.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.withTime(
 *     Effect.gen(function*() {
 *       yield* Effect.sleep("1 second")
 *       yield* Console.log("Operation completed")
 *     }),
 *     "my-operation"
 *   )
 * })
 * ```
 *
 * @since 2.0.0
 * @category accessor
 */
export const withTime = dual<
  (label?: string) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  <A, E, R>(self: Effect.Effect<A, E, R>, label?: string) => Effect.Effect<A, E, R>
>((args) => core.isEffect(args[0]), (self, label) =>
  consoleWith((console) =>
    effect.acquireUseRelease(
      effect.sync(() => {
        console.time(label)
      }),
      () => self,
      () =>
        effect.sync(() => {
          console.timeEnd(label)
        })
    )
  ))
