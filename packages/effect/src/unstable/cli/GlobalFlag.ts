/**
 * @since 4.0.0
 */

import * as Console from "../../Console.ts"
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import type { LogLevel as LogLevelType } from "../../LogLevel.ts"
import * as Option from "../../Option.ts"
import * as CliOutput from "./CliOutput.ts"
import type * as Command from "./Command.ts"
import * as Completions_ from "./Completions.ts"
import * as Flag from "./Flag.ts"
import * as CommandDescriptor from "./internal/completions/descriptor.ts"
import * as HelpInternal from "./internal/help.ts"

/* ========================================================================== */
/* Types                                                                      */
/* ========================================================================== */

/**
 * Context passed to action handlers.
 *
 * @since 4.0.0
 * @category models
 */
export interface HandlerContext {
  readonly command: Command.Command<any, unknown, any, unknown, unknown>
  readonly commandPath: ReadonlyArray<string>
  readonly version: string
}

/**
 * Action flag: side effect + exit (--help, --version, --completions).
 *
 * @since 4.0.0
 * @category models
 */
export interface Action<A> {
  readonly _tag: "Action"
  readonly flag: Flag.Flag<A>
  readonly run: (
    value: A,
    context: HandlerContext
  ) => Effect.Effect<void>
}

/**
 * Setting flag: configure command handler's environment (--log-level, --config).
 *
 * @since 4.0.0
 * @category models
 */
export interface Setting<Id extends string, A> extends Context.Service<Setting.Identifier<Id>, A> {
  readonly _tag: "Setting"
  readonly id: Id
  readonly flag: Flag.Flag<A>
}

/**
 * @since 4.0.0
 */
export declare namespace Setting {
  /**
   * @since 4.0.0
   * @category models
   */
  export type Identifier<Id extends string> = `effect/unstable/cli/GlobalFlag/${Id}`
}

/**
 * Global flag discriminated union.
 *
 * @since 4.0.0
 * @category models
 */
export type GlobalFlag<A> = Action<A> | Setting<any, A>

/* ========================================================================== */
/* Constructors                                                               */
/* ========================================================================== */

/**
 * Creates an Action flag that performs a side effect and exits.
 *
 * @since 4.0.0
 * @category constructors
 */
export const action = <A>(options: {
  readonly flag: Flag.Flag<A>
  readonly run: (
    value: A,
    context: HandlerContext
  ) => Effect.Effect<void>
}): Action<A> => ({
  _tag: "Action",
  flag: options.flag,
  run: options.run
})

/**
 * Creates a Setting flag that configures the command handler's environment.
 *
 * @since 4.0.0
 * @category constructors
 */
export const setting = <const Id extends string>(
  id: Id
) =>
<A>(options: {
  readonly flag: Flag.Flag<A>
}): Setting<Id, A> => {
  settingIdCounter += 1
  const ref = Context.Service<Setting.Identifier<Id>, A>(
    `effect/unstable/cli/GlobalFlag/${id}/${settingIdCounter}`
  )
  return Object.assign(ref, {
    _tag: "Setting" as const,
    id,
    flag: options.flag
  })
}

let settingIdCounter = 0

/* ========================================================================== */
/* Built-in Flag References                                                   */
/* ========================================================================== */

/**
 * The `--help` / `-h` global flag.
 * Shows help documentation for the command.
 *
 * @since 4.0.0
 * @category references
 */
export const Help: Action<boolean> = action({
  flag: Flag.boolean("help").pipe(
    Flag.withAlias("h"),
    Flag.withDescription("Show help information")
  ),
  run: (_, { command, commandPath }) =>
    Effect.gen(function*() {
      const formatter = yield* CliOutput.Formatter
      const helpDoc = yield* HelpInternal.getHelpForCommandPath(command, commandPath, BuiltIns)
      yield* Console.log(formatter.formatHelpDoc(helpDoc))
    })
})

/**
 * The `--version` global flag.
 * Shows version information for the command.
 *
 * @since 4.0.0
 * @category references
 */
export const Version: Action<boolean> = action({
  flag: Flag.boolean("version").pipe(
    Flag.withDescription("Show version information")
  ),
  run: (_, { command, version }) =>
    Effect.gen(function*() {
      const formatter = yield* CliOutput.Formatter
      yield* Console.log(formatter.formatVersion(command.name, version))
    })
})

/**
 * The `--completions` global flag.
 * Prints shell completion script for the given shell.
 *
 * @since 4.0.0
 * @category references
 */
export const Completions: Action<Option.Option<"bash" | "zsh" | "fish">> = action({
  flag: Flag.choice("completions", ["bash", "zsh", "fish", "sh"] as const)
    .pipe(
      Flag.optional,
      Flag.map((v) => Option.map(v, (s) => s === "sh" ? "bash" : s)),
      Flag.withDescription("Print shell completion script")
    ),
  run: (shell, { command }) =>
    Effect.gen(function*() {
      if (Option.isNone(shell)) return
      const descriptor = CommandDescriptor.fromCommand(command)
      yield* Console.log(
        Completions_.generate(command.name, shell.value, descriptor)
      )
    })
})

/**
 * The `--log-level` global flag.
 * Sets the minimum log level for the command.
 *
 * @since 4.0.0
 * @category references
 */
export const LogLevel: Setting<"log-level", Option.Option<LogLevelType>> = setting("log-level")({
  flag: Flag.choiceWithValue(
    "log-level",
    [
      ["all", "All"],
      ["trace", "Trace"],
      ["debug", "Debug"],
      ["info", "Info"],
      ["warn", "Warn"],
      ["warning", "Warn"],
      ["error", "Error"],
      ["fatal", "Fatal"],
      ["none", "None"]
    ] as const
  ).pipe(
    Flag.optional,
    Flag.withDescription("Sets the minimum log level")
  )
})

/* ========================================================================== */
/* References                                                                 */
/* ========================================================================== */

/**
 * Built-in global flags in default precedence order.
 *
 * @since 4.0.0
 * @category references
 */
export const BuiltIns: ReadonlyArray<GlobalFlag<any>> = [
  Help,
  Version,
  Completions,
  LogLevel
]

/**
 * Built-in setting context identifiers.
 *
 * @since 4.0.0
 * @category models
 */
export type BuiltInSettingContext = Setting.Identifier<"log-level">
