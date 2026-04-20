/**
 * @since 4.0.0
 */
import type { NonEmptyArray, NonEmptyReadonlyArray } from "../../Array.ts"
import * as Console from "../../Console.ts"
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import type * as FileSystem from "../../FileSystem.ts"
import { dual } from "../../Function.ts"
import type * as Layer from "../../Layer.ts"
import * as Option from "../../Option.ts"
import type * as Path from "../../Path.ts"
import type { Pipeable } from "../../Pipeable.ts"
import * as Predicate from "../../Predicate.ts"
import * as References from "../../References.ts"
import * as Result from "../../Result.ts"
import * as Stdio from "../../Stdio.ts"
import * as Terminal from "../../Terminal.ts"
import type { NoInfer, Simplify } from "../../Types.ts"
import type { ChildProcessSpawner } from "../process/ChildProcessSpawner.ts"
import * as CliError from "./CliError.ts"
import * as CliOutput from "./CliOutput.ts"
import * as GlobalFlag from "./GlobalFlag.ts"
import { checkForDuplicateFlags, makeCommand, makeParser, toImpl, TypeId } from "./internal/command.ts"
import { mergeConfig, parseConfig } from "./internal/config.ts"
import { getGlobalFlagsForCommandPath, getGlobalFlagsForCommandTree, getHelpForCommandPath } from "./internal/help.ts"
import * as Lexer from "./internal/lexer.ts"
import * as Parser from "./internal/parser.ts"
import * as Param from "./Param.ts"

/* ========================================================================== */
/* Public Types                                                               */
/* ========================================================================== */

/**
 * Represents a CLI command with its configuration, handler, and metadata.
 *
 * Commands are the core building blocks of CLI applications. They define:
 * - The command name and description
 * - Configuration including flags and arguments
 * - Handler function for execution
 * - Optional subcommands for hierarchical structures
 *
 * @example
 * ```ts
 * import { Console } from "effect"
 * import { Argument, Command, Flag } from "effect/unstable/cli"
 *
 * // Simple command with no configuration
 * const version: Command.Command<"version", {}, {}, never, never> = Command.make(
 *   "version"
 * )
 *
 * // Command with flags and arguments
 * const deploy: Command.Command<
 *   "deploy",
 *   {
 *     readonly env: string
 *     readonly force: boolean
 *     readonly files: ReadonlyArray<string>
 *   },
 *   {},
 *   never,
 *   never
 * > = Command.make("deploy", {
 *   env: Flag.string("env"),
 *   force: Flag.boolean("force"),
 *   files: Argument.string("files").pipe(Argument.variadic())
 * })
 *
 * // Command with handler
 * const greet = Command.make("greet", {
 *   name: Flag.string("name")
 * }, (config) => Console.log(`Hello, ${config.name}!`))
 * ```
 *
 * @since 4.0.0
 * @category models
 */
export interface Command<Name extends string, Input, ContextInput = {}, E = never, R = never>
  extends
    Pipeable,
    Effect.Yieldable<
      Command<Name, Input, ContextInput, E, R>,
      ContextInput,
      never,
      CommandContext<Name>
    >
{
  readonly [TypeId]: typeof TypeId

  /**
   * The name of the command.
   */
  readonly name: Name

  /**
   * An optional description of the command.
   */
  readonly description: string | undefined

  /**
   * An optional short description used when listing subcommands.
   */
  readonly shortDescription: string | undefined

  /**
   * An optional alias that can be used as a shorter command name.
   */
  readonly alias: string | undefined

  /**
   * Optional usage examples for the command.
   */
  readonly examples: ReadonlyArray<Command.Example>

  /**
   * The subcommands available under this command.
   */
  readonly subcommands: ReadonlyArray<{
    readonly group: string | undefined
    readonly commands: NonEmptyReadonlyArray<Command.Any>
  }>

  /**
   * Custom annotations associated with this command.
   */
  readonly annotations: Context.Context<never>
}

/**
 * @since 4.0.0
 */
export declare namespace Command {
  /**
   * Represents a concrete usage example for a command.
   *
   * @since 4.0.0
   * @category models
   */
  export interface Example {
    readonly command: string
    readonly description?: string | undefined
  }

  /**
   * Configuration object for defining command flags, arguments, and nested structures.
   *
   * Command.Config allows you to specify:
   * - Individual flags and arguments using Param types
   * - Nested configuration objects for organization
   * - Arrays of parameters for repeated elements
   *
   * @example
   * ```ts
   * import { Argument, Flag } from "effect/unstable/cli"
   * import type * as CliCommand from "effect/unstable/cli/Command"
   *
   * // Simple flat configuration
   * const simpleConfig: CliCommand.Command.Config = {
   *   name: Flag.string("name"),
   *   age: Flag.integer("age"),
   *   file: Argument.string("file")
   * }
   *
   * // Nested configuration for organization
   * const nestedConfig: CliCommand.Command.Config = {
   *   user: {
   *     name: Flag.string("name"),
   *     email: Flag.string("email")
   *   },
   *   server: {
   *     host: Flag.string("host"),
   *     port: Flag.integer("port")
   *   }
   * }
   * ```
   *
   * @since 4.0.0
   * @category models
   */
  export interface Config {
    readonly [key: string]:
      | Param.Param<Param.ParamKind, any>
      | ReadonlyArray<Param.Param<Param.ParamKind, any> | Config>
      | Config
  }

  /**
   * Configuration shape accepted by `Command.withSharedFlags`.
   *
   * Only flags are allowed here; arguments are intentionally excluded.
   *
   * @since 4.0.0
   * @category models
   */
  export interface FlagConfig {
    readonly [key: string]:
      | Param.Param<typeof Param.flagKind, any>
      | ReadonlyArray<Param.Param<typeof Param.flagKind, any> | FlagConfig>
      | FlagConfig
  }

  /**
   * Utilities for working with command configurations.
   *
   * @since 4.0.0
   * @category models
   */
  export namespace Config {
    /**
     * Infers the TypeScript type from a Command.Config structure.
     *
     * This type utility extracts the final configuration type that handlers will receive,
     * preserving the nested structure while converting Param types to their values.
     *
     * @example
     * ```ts
     * import { Flag } from "effect/unstable/cli"
     * import type * as CliCommand from "effect/unstable/cli/Command"
     *
     * const config = {
     *   name: Flag.string("name"),
     *   server: {
     *     host: Flag.string("host"),
     *     port: Flag.integer("port")
     *   }
     * } as const
     *
     * type Result = CliCommand.Command.Config.Infer<typeof config>
     * // {
     * //   readonly name: string
     * //   readonly server: {
     * //     readonly host: string
     * //     readonly port: number
     * //   }
     * // }
     * ```
     *
     * @since 4.0.0
     * @category models
     */
    export type Infer<A extends Config> = Simplify<
      { readonly [Key in keyof A]: InferValue<A[Key]> }
    >

    /**
     * Helper type utility for recursively inferring types from Config values.
     *
     * @since 4.0.0
     * @category models
     */
    export type InferValue<A> = A extends ReadonlyArray<any> ? { readonly [Key in keyof A]: InferValue<A[Key]> }
      : A extends Param.Param<infer _Kind, infer _Value> ? _Value
      : A extends Config ? Infer<A>
      : never
  }

  /**
   * Represents any Command regardless of its type parameters.
   *
   * @since 4.0.0
   * @category models
   */
  export type Any = Command<string, unknown, unknown, unknown, unknown>

  /**
   * A grouped set of subcommands used by `Command.withSubcommands`.
   *
   * @since 4.0.0
   * @category models
   */
  export interface SubcommandGroup<Commands extends ReadonlyArray<Any> = ReadonlyArray<Any>> {
    readonly group: string
    readonly commands: Commands
  }

  /**
   * Entry type accepted by `Command.withSubcommands`.
   *
   * @since 4.0.0
   * @category models
   */
  export type SubcommandEntry = Any | SubcommandGroup<ReadonlyArray<Any>>
}

/**
 * The environment required by CLI commands, including file system and path operations.
 *
 * @since 4.0.0
 * @category utility types
 */
export type Environment = FileSystem.FileSystem | Path.Path | Terminal.Terminal | ChildProcessSpawner | Stdio.Stdio

/**
 * A utility type to extract the error type from a `Command`.
 *
 * @since 4.0.0
 * @category utility types
 */
export type Error<C> = C extends Command<
  infer _Name,
  infer _Input,
  infer _ContextInput,
  infer _Error,
  infer _Requirements
> ? _Error :
  never

/**
 * Service context for a specific command, enabling subcommands to access their parent's parsed configuration.
 *
 * When a subcommand handler needs access to flags or arguments from a parent command,
 * it can yield the parent command directly to retrieve its config. This is powered by
 * Effect's service system - each command automatically creates a service that provides
 * its parsed input to child commands.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 * import { Command, Flag } from "effect/unstable/cli"
 *
 * const parent = Command.make("app").pipe(
 *   Command.withSharedFlags({
 *     verbose: Flag.boolean("verbose"),
 *     config: Flag.string("config")
 *   })
 * )
 *
 * const child = Command.make("deploy", {
 *   target: Flag.string("target")
 * }, (config) =>
 *   Effect.gen(function*() {
 *     // Access parent's config by yielding the parent command
 *     const parentConfig = yield* parent
 *     yield* Console.log(`Verbose: ${parentConfig.verbose}`)
 *     yield* Console.log(`Config: ${parentConfig.config}`)
 *     yield* Console.log(`Target: ${config.target}`)
 *   }))
 *
 * const app = parent.pipe(Command.withSubcommands([child]))
 * // Usage: app --verbose --config prod.json deploy --target staging
 * ```
 *
 * @since 4.0.0
 * @category models
 */
export interface CommandContext<Name extends string> {
  readonly _: unique symbol
  readonly name: Name
}

/**
 * Represents the parsed tokens from command-line input before validation.
 *
 * @since 4.0.0
 * @category models
 */
export interface ParsedTokens {
  readonly flags: Record<string, ReadonlyArray<string>>
  readonly arguments: ReadonlyArray<string>
  readonly errors?: ReadonlyArray<CliError.NonShowHelpErrors>
  readonly subcommand: Option.Option<{
    readonly name: string
    readonly parsedInput: ParsedTokens
  }>
}

/**
 * @since 4.0.0
 * @category Guards
 */
export const isCommand = (u: unknown): u is Command.Any => Predicate.hasProperty(u, TypeId)

/* ========================================================================== */
/* Constructors                                                               */
/* ========================================================================== */

/**
 * Creates a Command from a name, optional config, optional handler function, and optional description.
 *
 * The make function is the primary constructor for CLI commands. It provides multiple overloads
 * to support different patterns of command creation, from simple commands with no configuration
 * to complex commands with nested configurations and error handling.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 * import { Argument, Command, Flag } from "effect/unstable/cli"
 *
 * // Simple command with no configuration
 * const version = Command.make("version")
 *
 * // Command with simple flags
 * const greet = Command.make("greet", {
 *   name: Flag.string("name"),
 *   count: Flag.integer("count").pipe(Flag.withDefault(1))
 * })
 *
 * // Command with nested configuration
 * const deploy = Command.make("deploy", {
 *   environment: Flag.string("env").pipe(
 *     Flag.withDescription("Target environment")
 *   ),
 *   server: {
 *     host: Flag.string("host").pipe(Flag.withDefault("localhost")),
 *     port: Flag.integer("port").pipe(Flag.withDefault(3000))
 *   },
 *   files: Argument.string("files").pipe(Argument.variadic),
 *   force: Flag.boolean("force").pipe(Flag.withDescription("Force deployment"))
 * })
 *
 * // Command with handler
 * const deployWithHandler = Command.make("deploy", {
 *   environment: Flag.string("env"),
 *   force: Flag.boolean("force")
 * }, (config) =>
 *   Effect.gen(function*() {
 *     yield* Console.log(`Starting deployment to ${config.environment}`)
 *
 *     if (!config.force && config.environment === "production") {
 *       return yield* Effect.fail("Production deployments require --force flag")
 *     }
 *
 *     yield* Console.log("Deployment completed successfully")
 *   }))
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const make: {
  <Name extends string>(name: Name): Command<Name, {}, {}, never, never>

  <Name extends string, const Config extends Command.Config>(
    name: Name,
    config: Config
  ): Command<Name, Command.Config.Infer<Config>, {}, never, never>

  <Name extends string, const Config extends Command.Config, R, E>(
    name: Name,
    config: Config,
    handler: (config: Command.Config.Infer<Config>) => Effect.Effect<void, E, R>
  ): Command<Name, Command.Config.Infer<Config>, {}, E, Exclude<R, GlobalFlag.BuiltInSettingContext>>
} = ((
  name: string,
  config?: Command.Config,
  handler?: (config: unknown) => Effect.Effect<void, unknown, unknown>
) => {
  const parsedConfig = parseConfig(config ?? {})
  return makeCommand({
    name,
    config: parsedConfig,
    ...(Predicate.isNotUndefined(handler) ? { handle: handler } : {})
  })
}) as any

/* ========================================================================== */
/* Combinators                                                                */
/* ========================================================================== */

/**
 * Adds or replaces the handler for a command.
 *
 * @example
 * ```ts
 * import { Console } from "effect"
 * import { Command, Flag } from "effect/unstable/cli"
 *
 * // Command without initial handler
 * const greet = Command.make("greet", {
 *   name: Flag.string("name")
 * })
 *
 * // Add handler later
 * const greetWithHandler = greet.pipe(
 *   Command.withHandler((config: { readonly name: string }) =>
 *     Console.log(`Hello, ${config.name}!`)
 *   )
 * )
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const withHandler: {
  <A, R, E>(
    handler: (value: A) => Effect.Effect<void, E, R>
  ): <Name extends string, XR, XE, ContextInput>(
    self: Command<Name, A, ContextInput, XE, XR>
  ) => Command<Name, A, ContextInput, E, Exclude<R, GlobalFlag.BuiltInSettingContext>>
  <Name extends string, A, XR, XE, R, E, ContextInput>(
    self: Command<Name, A, ContextInput, XE, XR>,
    handler: (value: A) => Effect.Effect<void, E, R>
  ): Command<Name, A, ContextInput, E, Exclude<R, GlobalFlag.BuiltInSettingContext>>
} = dual(2, <Name extends string, A, XR, XE, R, E, ContextInput>(
  self: Command<Name, A, ContextInput, XE, XR>,
  handler: (value: A) => Effect.Effect<void, E, R>
): Command<Name, A, ContextInput, E, Exclude<R, GlobalFlag.BuiltInSettingContext>> =>
  makeCommand({ ...toImpl(self), handle: handler }))

interface SubcommandGroupInternal {
  readonly group: string | undefined
  readonly commands: NonEmptyReadonlyArray<Command.Any>
}

const normalizeSubcommandEntries = (
  entries: ReadonlyArray<Command.SubcommandEntry>
): {
  readonly flat: ReadonlyArray<Command.Any>
  readonly groups: ReadonlyArray<SubcommandGroupInternal>
} => {
  const flat: Array<Command.Any> = []
  const grouped = new Map<string | undefined, NonEmptyArray<Command.Any>>()

  const addToGroup = (group: string | undefined, command: Command.Any): void => {
    flat.push(command)
    const existing = grouped.get(group)
    if (existing) {
      existing.push(command)
    } else {
      grouped.set(group, [command])
    }
  }

  for (const entry of entries) {
    if (isCommand(entry)) {
      addToGroup(undefined, entry)
      continue
    }
    for (const command of entry.commands) {
      addToGroup(entry.group, command)
    }
  }

  const groups: Array<SubcommandGroupInternal> = []
  const ungroupedCommands = grouped.get(undefined)

  if (ungroupedCommands && ungroupedCommands.length > 0) {
    groups.push({ group: undefined, commands: ungroupedCommands })
  }

  for (const [group, commands] of grouped) {
    if (group === undefined) {
      continue
    }
    groups.push({ group, commands })
  }

  return { flat, groups }
}

/**
 * Adds subcommands to a command, creating a hierarchical command structure.
 *
 * Subcommands can access their parent's parsed configuration by yielding the parent
 * command within their handler. This enables shared parent flags that affect
 * all subcommands.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 * import { Command, Flag } from "effect/unstable/cli"
 *
 * // Parent command with shared flags
 * const git = Command.make("git").pipe(
 *   Command.withSharedFlags({
 *     verbose: Flag.boolean("verbose")
 *   })
 * )
 *
 * // Subcommand that accesses parent config
 * const clone = Command.make("clone", {
 *   repository: Flag.string("repo")
 * }, (config) =>
 *   Effect.gen(function*() {
 *     const parent = yield* git // Access parent's parsed config
 *     if (parent.verbose) {
 *       yield* Console.log("Verbose mode enabled")
 *     }
 *     yield* Console.log(`Cloning ${config.repository}`)
 *   }))
 *
 * const app = git.pipe(Command.withSubcommands([clone]))
 * // Usage: git --verbose clone --repo github.com/foo/bar
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const withSubcommands: {
  <const Subcommands extends ReadonlyArray<Command.SubcommandEntry>>(
    subcommands: Subcommands
  ): <Name extends string, Input, E, R, ContextInput>(
    self: Command<Name, Input, ContextInput, E, R>
  ) => Command<
    Name,
    Simplify<Input | ContextInput>,
    ContextInput,
    E | ExtractSubcommandErrors<Subcommands>,
    R | Exclude<ExtractSubcommandContext<Subcommands>, CommandContext<Name>>
  >
  <
    Name extends string,
    Input,
    E,
    R,
    ContextInput,
    const Subcommands extends ReadonlyArray<Command.SubcommandEntry>
  >(
    self: Command<Name, Input, ContextInput, E, R>,
    subcommands: Subcommands
  ): Command<
    Name,
    Simplify<Input | ContextInput>,
    ContextInput,
    E | ExtractSubcommandErrors<Subcommands>,
    R | Exclude<ExtractSubcommandContext<Subcommands>, CommandContext<Name>>
  >
} = dual(2, <
  Name extends string,
  Input,
  E,
  R,
  ContextInput,
  const Subcommands extends ReadonlyArray<Command.SubcommandEntry>
>(
  self: Command<Name, Input, ContextInput, E, R>,
  subcommands: Subcommands
): Command<
  Name,
  Simplify<Input | ContextInput>,
  ContextInput,
  E | ExtractSubcommandErrors<Subcommands>,
  R | Exclude<ExtractSubcommandContext<Subcommands>, CommandContext<Name>>
> => {
  const normalized = normalizeSubcommandEntries(subcommands)
  checkForDuplicateFlags(self, normalized.flat)

  const impl = toImpl(self)
  const byName = new Map(normalized.flat.map((s) => [s.name, toImpl(s)] as const))

  type NextInput = Simplify<Input | ContextInput>
  const SubcommandStateSymbol = Symbol("effect/cli/SubcommandState")
  type SubcommandState = { readonly name: string; readonly result: unknown }
  type InternalInput = NextInput & { readonly [SubcommandStateSymbol]?: SubcommandState }

  const parse = Effect.fnUntraced(function*(raw: ParsedTokens) {
    if (Option.isNone(raw.subcommand)) {
      return (yield* impl.parse(raw)) as NextInput
    }

    const sub = byName.get(raw.subcommand.value.name)
    if (!sub) {
      return (yield* impl.parse(raw)) as NextInput
    }

    const context = yield* impl.parseContext(raw)
    const result = yield* sub.parse(raw.subcommand.value.parsedInput)
    return Object.assign({}, context, { [SubcommandStateSymbol]: { name: sub.name, result } }) as NextInput
  })

  const handle = Effect.fnUntraced(function*(input: NextInput, path: ReadonlyArray<string>) {
    const internal = input as InternalInput
    const selectedSubcommand = internal[SubcommandStateSymbol]

    if (selectedSubcommand) {
      const child = byName.get(selectedSubcommand.name)
      if (!child) {
        return yield* new CliError.ShowHelp({ commandPath: path, errors: [] })
      }
      return yield* child
        .handle(selectedSubcommand.result, [...path, child.name])
        .pipe(Effect.provideService(impl.service, input as unknown as ContextInput))
    }
    return yield* impl.handle(input as Input, path)
  })

  return makeCommand({
    name: impl.name,
    config: impl.config,
    contextConfig: impl.contextConfig,
    description: impl.description,
    shortDescription: impl.shortDescription,
    alias: impl.alias,
    annotations: impl.annotations,
    globalFlags: impl.globalFlags,
    examples: impl.examples,
    service: impl.service,
    subcommands: normalized.groups,
    parse,
    parseContext: impl.parseContext,
    handle
  })
})

/**
 * Adds flags that are inherited by subcommands.
 *
 * Shared flags are available to this command's handler and to descendant
 * handlers via `yield* parentCommand`. Shared flags are accepted both before
 * and after a selected subcommand name (npm-style).
 *
 * @since 4.0.0
 * @category combinators
 */
export const withSharedFlags: {
  <const SharedFlags extends Command.FlagConfig>(
    sharedFlags: SharedFlags
  ): <Name extends string, Input, E, R, ContextInput>(
    self: Command<Name, Input, ContextInput, E, R>
  ) => Command<
    Name,
    Simplify<Input & Command.Config.Infer<SharedFlags>>,
    Simplify<ContextInput & Command.Config.Infer<SharedFlags>>,
    E,
    R
  >
  <Name extends string, Input, E, R, ContextInput, const SharedFlags extends Command.FlagConfig>(
    self: Command<Name, Input, ContextInput, E, R>,
    sharedFlags: SharedFlags
  ): Command<
    Name,
    Simplify<Input & Command.Config.Infer<SharedFlags>>,
    Simplify<ContextInput & Command.Config.Infer<SharedFlags>>,
    E,
    R
  >
} = dual(
  2,
  <Name extends string, Input, E, R, ContextInput, const SharedFlags extends Command.FlagConfig>(
    self: Command<Name, Input, ContextInput, E, R>,
    sharedFlags: SharedFlags
  ): Command<
    Name,
    Simplify<Input & Command.Config.Infer<SharedFlags>>,
    Simplify<ContextInput & Command.Config.Infer<SharedFlags>>,
    E,
    R
  > => {
    const impl = toImpl(self)
    const sharedConfig = parseConfig(sharedFlags)
    const mergedConfig = mergeConfig(impl.config, sharedConfig)
    const mergedContextConfig = mergeConfig(impl.contextConfig, sharedConfig)

    if (impl.subcommands.length > 0) {
      const flatSubcommands = impl.subcommands.flatMap((group) => group.commands)
      checkForDuplicateFlags(self, flatSubcommands, { contextConfig: mergedContextConfig })
    }

    type SharedInput = Command.Config.Infer<SharedFlags>
    type NextInput = Simplify<Input & SharedInput>
    type NextContextInput = Simplify<ContextInput & SharedInput>

    const parseShared = makeParser(sharedConfig) as (
      input: ParsedTokens
    ) => Effect.Effect<SharedInput, CliError.CliError, Environment>

    const parse = Effect.fnUntraced(function*(raw: ParsedTokens) {
      const base = yield* impl.parse(raw)
      const shared = yield* parseShared(raw)
      return Object.assign({}, base, shared) as NextInput
    })

    const parseContext = Effect.fnUntraced(function*(raw: ParsedTokens) {
      const base = yield* impl.parseContext(raw)
      const shared = yield* parseShared(raw)
      return Object.assign({}, base, shared) as NextContextInput
    })

    const handle = (
      input: NextInput,
      commandPath: ReadonlyArray<string>
    ) => impl.handle(input as Input, commandPath)

    return makeCommand({
      name: impl.name,
      config: mergedConfig,
      contextConfig: mergedContextConfig,
      description: impl.description,
      shortDescription: impl.shortDescription,
      alias: impl.alias,
      annotations: impl.annotations,
      globalFlags: impl.globalFlags,
      examples: impl.examples,
      service: impl.service as Context.Key<CommandContext<Name>, NextContextInput>,
      subcommands: impl.subcommands,
      parse,
      parseContext,
      handle
    })
  }
)

/**
 * Declares global flags for a command scope.
 *
 * Declared global flags apply to the command and all of its descendants.
 *
 * @since 4.0.0
 * @category combinators
 */
export const withGlobalFlags: {
  <const GlobalFlags extends ReadonlyArray<GlobalFlag.GlobalFlag<any>>>(
    globalFlags: GlobalFlags
  ): <Name extends string, Input, E, R, ContextInput>(
    self: Command<Name, Input, ContextInput, E, R>
  ) => Command<Name, Input, ContextInput, E, Exclude<R, ExtractGlobalFlagContext<GlobalFlags>>>
  <
    Name extends string,
    Input,
    E,
    R,
    ContextInput,
    const GlobalFlags extends ReadonlyArray<GlobalFlag.GlobalFlag<any>>
  >(
    self: Command<Name, Input, ContextInput, E, R>,
    globalFlags: GlobalFlags
  ): Command<Name, Input, ContextInput, E, Exclude<R, ExtractGlobalFlagContext<GlobalFlags>>>
} = dual(
  2,
  <
    Name extends string,
    Input,
    E,
    R,
    ContextInput,
    const GlobalFlags extends ReadonlyArray<GlobalFlag.GlobalFlag<any>>
  >(
    self: Command<Name, Input, ContextInput, E, R>,
    globalFlags: GlobalFlags
  ): Command<Name, Input, ContextInput, E, Exclude<R, ExtractGlobalFlagContext<GlobalFlags>>> => {
    const impl = toImpl(self)
    const next = Array.from(new Set([...impl.globalFlags, ...globalFlags]))
    return makeCommand({ ...impl, globalFlags: next })
  }
)

// Type extractors for subcommand arrays - T[number] gives union of all elements
type ExtractGlobalFlagContext<T extends ReadonlyArray<GlobalFlag.GlobalFlag<any>>> = T[number] extends infer F
  ? F extends GlobalFlag.Setting<infer Id, infer _A> ? GlobalFlag.Setting.Identifier<Id>
  : never
  : never
type ExtractSubcommand<T> = T extends Command<infer _Name, infer _Input, infer _CI, infer _E, infer _R> ? T
  : T extends Command.SubcommandGroup<infer Commands> ? Commands[number]
  : never
type ExtractSubcommandErrors<T extends ReadonlyArray<Command.SubcommandEntry>> = Error<ExtractSubcommand<T[number]>>
type ExtractSubcommandContext<T extends ReadonlyArray<Command.SubcommandEntry>> = ExtractSubcommand<T[number]> extends
  Command<infer _Name, infer _Input, infer _CI, infer _E, infer _R> ? _R : never

/**
 * Sets the description for a command.
 *
 * Descriptions provide users with information about what the command does
 * when they view help documentation.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 * import { Command, Flag } from "effect/unstable/cli"
 *
 * const deploy = Command.make("deploy", {
 *   environment: Flag.string("env")
 * }, (config) =>
 *   Effect.gen(function*() {
 *     yield* Console.log(`Deploying to ${config.environment}`)
 *   })).pipe(
 *     Command.withDescription("Deploy the application to a specified environment")
 *   )
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const withDescription: {
  (description: string): <const Name extends string, Input, E, R, ContextInput>(
    self: Command<Name, Input, ContextInput, E, R>
  ) => Command<Name, Input, ContextInput, E, R>
  <const Name extends string, Input, E, R, ContextInput>(
    self: Command<Name, Input, ContextInput, E, R>,
    description: string
  ): Command<Name, Input, ContextInput, E, R>
} = dual(2, <const Name extends string, Input, E, R, ContextInput>(
  self: Command<Name, Input, ContextInput, E, R>,
  description: string
) => makeCommand({ ...toImpl(self), description }))

/**
 * Sets a short description for a command.
 *
 * Short descriptions are used when listing subcommands in help output and
 * shell completions. If no short description is provided, the full
 * `description` is used as a fallback.
 *
 * @since 4.0.0
 * @category combinators
 */
export const withShortDescription: {
  (shortDescription: string): <const Name extends string, Input, E, R, ContextInput>(
    self: Command<Name, Input, ContextInput, E, R>
  ) => Command<Name, Input, ContextInput, E, R>
  <const Name extends string, Input, E, R, ContextInput>(
    self: Command<Name, Input, ContextInput, E, R>,
    shortDescription: string
  ): Command<Name, Input, ContextInput, E, R>
} = dual(2, <const Name extends string, Input, E, R, ContextInput>(
  self: Command<Name, Input, ContextInput, E, R>,
  shortDescription: string
) => makeCommand({ ...toImpl(self), shortDescription }))

/**
 * Sets an alias for a command.
 *
 * Aliases are accepted as alternate subcommand names during parsing and are
 * shown in help output as `name, alias`.
 *
 * @since 4.0.0
 * @category combinators
 */
export const withAlias: {
  (alias: string): <const Name extends string, Input, E, R, ContextInput>(
    self: Command<Name, Input, ContextInput, E, R>
  ) => Command<Name, Input, ContextInput, E, R>
  <const Name extends string, Input, E, R, ContextInput>(
    self: Command<Name, Input, ContextInput, E, R>,
    alias: string
  ): Command<Name, Input, ContextInput, E, R>
} = dual(2, <const Name extends string, Input, E, R, ContextInput>(
  self: Command<Name, Input, ContextInput, E, R>,
  alias: string
) => makeCommand({ ...toImpl(self), alias }))

/**
 * Adds a custom annotation to a command.
 *
 * @since 4.0.0
 * @category combinators
 */
export const annotate: {
  <I, S>(
    service: Context.Key<I, S>,
    value: NoInfer<S>
  ): <Name extends string, Input, E, R, ContextInput>(
    self: Command<Name, Input, ContextInput, E, R>
  ) => Command<Name, Input, ContextInput, E, R>
  <Name extends string, Input, E, R, ContextInput, I, S>(
    self: Command<Name, Input, ContextInput, E, R>,
    service: Context.Key<I, S>,
    value: NoInfer<S>
  ): Command<Name, Input, ContextInput, E, R>
} = dual(3, <Name extends string, Input, E, R, ContextInput, I, S>(
  self: Command<Name, Input, ContextInput, E, R>,
  service: Context.Key<I, S>,
  value: NoInfer<S>
) => {
  const impl = toImpl(self)
  return makeCommand({ ...impl, annotations: Context.add(impl.annotations, service, value) })
})

/**
 * Merges a Context of annotations into a command.
 *
 * @since 4.0.0
 * @category combinators
 */
export const annotateMerge: {
  <I>(
    annotations: Context.Context<I>
  ): <Name extends string, Input, E, R, ContextInput>(
    self: Command<Name, Input, ContextInput, E, R>
  ) => Command<Name, Input, ContextInput, E, R>
  <Name extends string, Input, E, R, ContextInput, I>(
    self: Command<Name, Input, ContextInput, E, R>,
    annotations: Context.Context<I>
  ): Command<Name, Input, ContextInput, E, R>
} = dual(2, <Name extends string, Input, E, R, ContextInput, I>(
  self: Command<Name, Input, ContextInput, E, R>,
  annotations: Context.Context<I>
) => {
  const impl = toImpl(self)
  return makeCommand({ ...impl, annotations: Context.merge(impl.annotations, annotations) })
})

/**
 * Sets usage examples for a command.
 *
 * Examples are exposed in structured `HelpDoc` data and rendered by the
 * default formatter in an `EXAMPLES` section.
 *
 * @example
 * ```ts
 * import { Command } from "effect/unstable/cli"
 *
 * const login = Command.make("login").pipe(
 *   Command.withExamples([
 *     { command: "myapp login", description: "Log in with browser OAuth" },
 *     { command: "myapp login --token sbp_abc123", description: "Log in with a token" }
 *   ])
 * )
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const withExamples: {
  (examples: ReadonlyArray<Command.Example>): <const Name extends string, Input, E, R, ContextInput>(
    self: Command<Name, Input, ContextInput, E, R>
  ) => Command<Name, Input, ContextInput, E, R>
  <const Name extends string, Input, E, R, ContextInput>(
    self: Command<Name, Input, ContextInput, E, R>,
    examples: ReadonlyArray<Command.Example>
  ): Command<Name, Input, ContextInput, E, R>
} = dual(2, <const Name extends string, Input, E, R, ContextInput>(
  self: Command<Name, Input, ContextInput, E, R>,
  examples: ReadonlyArray<Command.Example>
) => makeCommand({ ...toImpl(self), examples }))

/* ========================================================================== */
/* Providing Services                                                         */
/* ========================================================================== */

// Internal helper: transforms a command's handler while preserving other properties
const mapHandler = <Name extends string, Input, E, R, ContextInput, E2, R2>(
  self: Command<Name, Input, ContextInput, E, R>,
  f: (handler: Effect.Effect<void, E | CliError.CliError, R | Environment>, input: Input) => Effect.Effect<void, E2, R2>
): Command<Name, Input, ContextInput, E2, R2> => {
  const impl = toImpl(self)
  return makeCommand({ ...impl, handle: (input, path) => f(impl.handle(input, path), input) })
}

/**
 * Provides the handler of a command with the services produced by a layer
 * that optionally depends on the command-line input to be created.
 *
 * @example
 * ```ts
 * import { Effect, FileSystem, PlatformError } from "effect"
 * import { Command, Flag } from "effect/unstable/cli"
 *
 * const deploy = Command.make("deploy", {
 *   env: Flag.string("env")
 * }, (config) =>
 *   Effect.gen(function*() {
 *     const fs = yield* FileSystem.FileSystem
 *     // Use fs...
 *   })).pipe(
 *     // Provide FileSystem based on the --env flag
 *     Command.provide((config) =>
 *       config.env === "local"
 *         ? FileSystem.layerNoop({})
 *         : FileSystem.layerNoop({
 *           access: () =>
 *             Effect.fail(
 *               PlatformError.badArgument({
 *                 module: "FileSystem",
 *                 method: "access"
 *               })
 *             )
 *         })
 *     )
 *   )
 * ```
 *
 * @since 4.0.0
 * @category providing services
 */
export const provide: {
  <Input, LR, LE, LA>(
    layer: Layer.Layer<LA, LE, LR> | ((input: Input) => Layer.Layer<LA, LE, LR>),
    options?: {
      readonly local?: boolean | undefined
    } | undefined
  ): <const Name extends string, E, R, ContextInput>(
    self: Command<Name, Input, ContextInput, E, R>
  ) => Command<Name, Input, ContextInput, E | LE, Exclude<R, LA> | LR>
  <const Name extends string, Input, E, R, ContextInput, LA, LE, LR>(
    self: Command<Name, Input, ContextInput, E, R>,
    layer: Layer.Layer<LA, LE, LR> | ((input: Input) => Layer.Layer<LA, LE, LR>),
    options?: {
      readonly local?: boolean | undefined
    } | undefined
  ): Command<Name, Input, ContextInput, E | LE, Exclude<R, LA> | LR>
} = dual((args) => isCommand(args[0]), <const Name extends string, Input, E, R, ContextInput, LA, LE, LR>(
  self: Command<Name, Input, ContextInput, E, R>,
  layer: Layer.Layer<LA, LE, LR> | ((input: Input) => Layer.Layer<LA, LE, LR>),
  options?: { readonly local?: boolean | undefined } | undefined
) =>
  mapHandler(
    self,
    (handler, input) => Effect.provide(handler, typeof layer === "function" ? layer(input) : layer, options)
  ))

/**
 * Provides the handler of a command with the implementation of a service that
 * optionally depends on the command-line input to be constructed.
 *
 * @since 4.0.0
 * @category providing services
 */
export const provideSync: {
  <I, S, Input>(
    service: Context.Key<I, S>,
    implementation: S | ((input: Input) => S)
  ): <const Name extends string, E, R, ContextInput>(
    self: Command<Name, Input, ContextInput, E, R>
  ) => Command<Name, Input, ContextInput, E, Exclude<R, I>>
  <const Name extends string, Input, E, R, ContextInput, I, S>(
    self: Command<Name, Input, ContextInput, E, R>,
    service: Context.Key<I, S>,
    implementation: S | ((input: Input) => S)
  ): Command<Name, Input, ContextInput, E, Exclude<R, I>>
} = dual(3, <const Name extends string, Input, E, R, ContextInput, I, S>(
  self: Command<Name, Input, ContextInput, E, R>,
  service: Context.Key<I, S>,
  implementation: S | ((input: Input) => S)
) =>
  mapHandler(self, (handler, input) =>
    Effect.provideService(
      handler,
      service,
      typeof implementation === "function" ? (implementation as (input: Input) => S)(input) : implementation
    )))

/**
 * Provides the handler of a command with the service produced by an effect
 * that optionally depends on the command-line input to be created.
 *
 * @since 4.0.0
 * @category providing services
 */
export const provideEffect: {
  <I, S, Input, R2, E2>(
    service: Context.Key<I, S>,
    effect: Effect.Effect<S, E2, R2> | ((input: Input) => Effect.Effect<S, E2, R2>)
  ): <const Name extends string, E, R, ContextInput>(
    self: Command<Name, Input, ContextInput, E, R>
  ) => Command<Name, Input, ContextInput, E | E2, Exclude<R, I> | R2>
  <const Name extends string, Input, E, R, ContextInput, I, S, R2, E2>(
    self: Command<Name, Input, ContextInput, E, R>,
    service: Context.Key<I, S>,
    effect: Effect.Effect<S, E2, R2> | ((input: Input) => Effect.Effect<S, E2, R2>)
  ): Command<Name, Input, ContextInput, E | E2, Exclude<R, I> | R2>
} = dual(3, <const Name extends string, Input, E, R, ContextInput, I, S, R2, E2>(
  self: Command<Name, Input, ContextInput, E, R>,
  service: Context.Key<I, S>,
  effect: Effect.Effect<S, E2, R2> | ((input: Input) => Effect.Effect<S, E2, R2>)
) =>
  mapHandler(
    self,
    (handler, input) =>
      Effect.provideServiceEffect(handler, service, typeof effect === "function" ? effect(input) : effect)
  ))

/**
 * Allows for execution of an effect, which optionally depends on command-line
 * input to be created, prior to executing the handler of a command.
 *
 * @since 4.0.0
 * @category providing services
 */
export const provideEffectDiscard: {
  <_, Input, E2, R2>(
    effect: Effect.Effect<_, E2, R2> | ((input: Input) => Effect.Effect<_, E2, R2>)
  ): <const Name extends string, E, R, ContextInput>(
    self: Command<Name, Input, ContextInput, E, R>
  ) => Command<Name, Input, ContextInput, E | E2, R | R2>
  <const Name extends string, Input, E, R, ContextInput, _, E2, R2>(
    self: Command<Name, Input, ContextInput, E, R>,
    effect: Effect.Effect<_, E2, R2> | ((input: Input) => Effect.Effect<_, E2, R2>)
  ): Command<Name, Input, ContextInput, E | E2, R | R2>
} = dual(2, <const Name extends string, Input, E, R, ContextInput, _, E2, R2>(
  self: Command<Name, Input, ContextInput, E, R>,
  effect: Effect.Effect<_, E2, R2> | ((input: Input) => Effect.Effect<_, E2, R2>)
) =>
  mapHandler(self, (handler, input) => Effect.andThen(typeof effect === "function" ? effect(input) : effect, handler)))

/* ========================================================================== */
/* Execution                                                                  */
/* ========================================================================== */

const getOutOfScopeGlobalFlagErrors = (
  allFlags: ReadonlyArray<GlobalFlag.GlobalFlag<any>>,
  activeFlags: ReadonlyArray<GlobalFlag.GlobalFlag<any>>,
  flagMap: Record<string, ReadonlyArray<string>>,
  commandPath: ReadonlyArray<string>
): ReadonlyArray<CliError.UnrecognizedOption> => {
  const activeSet = new Set(activeFlags)
  const errors: Array<CliError.UnrecognizedOption> = []
  const seen = new Set<string>()

  for (const flag of allFlags) {
    if (activeSet.has(flag)) {
      continue
    }

    const singles = Param.extractSingleParams(flag.flag)
    for (const single of singles) {
      const entries = flagMap[single.name]
      if (!entries || entries.length === 0) {
        continue
      }
      const option = `--${single.name}`
      if (seen.has(option)) {
        continue
      }
      seen.add(option)
      errors.push(
        new CliError.UnrecognizedOption({
          option,
          suggestions: [],
          command: commandPath
        })
      )
    }
  }

  return errors
}

const showHelp = <Name extends string, Input, E, R, ContextInput>(
  command: Command<Name, Input, ContextInput, E, R>,
  error: CliError.ShowHelp
): Effect.Effect<void, CliError.CliError, Environment> =>
  Effect.gen(function*() {
    const formatter = yield* CliOutput.Formatter
    const helpDoc = yield* getHelpForCommandPath(command, error.commandPath, GlobalFlag.BuiltIns)
    yield* Console.log(formatter.formatHelpDoc(helpDoc))
    if (error.errors.length > 0) {
      yield* Console.error(formatter.formatErrors(error.errors as any))
    }
  })

/**
 * Runs a command with the provided input arguments.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 * import { Command, Flag } from "effect/unstable/cli"
 *
 * const greetCommand = Command.make("greet", {
 *   name: Flag.string("name")
 * }, (config) =>
 *   Effect.gen(function*() {
 *     yield* Console.log(`Hello, ${config.name}!`)
 *   }))
 *
 * // Automatically gets args from the Stdio service
 * const program = Command.run(greetCommand, {
 *   version: "1.0.0"
 * })
 * ```
 *
 * @since 4.0.0
 * @category command execution
 */
export const run: {
  (config: {
    readonly version: string
  }): <Name extends string, Input, E, R, ContextInput>(
    command: Command<Name, Input, ContextInput, E, R>
  ) => Effect.Effect<void, E | CliError.CliError, R | Environment>
  <Name extends string, Input, E, R, ContextInput>(
    command: Command<Name, Input, ContextInput, E, R>,
    config: {
      readonly version: string
    }
  ): Effect.Effect<void, E | CliError.CliError, R | Environment>
} = dual(2, <Name extends string, Input, E, R, ContextInput>(
  command: Command<Name, Input, ContextInput, E, R>,
  config: {
    readonly version: string
  }
) =>
  Stdio.Stdio.use(({ args }) =>
    Effect.flatMap(
      args,
      (args) => runWith(command, config)(args)
    )
  ))

/**
 * Runs a command with explicitly provided arguments instead of using process.argv.
 *
 * This function is useful for testing CLI applications or when you want to
 * programmatically execute commands with specific arguments.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 * import { Command, Flag } from "effect/unstable/cli"
 *
 * const greet = Command.make("greet", {
 *   name: Flag.string("name"),
 *   count: Flag.integer("count").pipe(Flag.withDefault(1))
 * }, (config) =>
 *   Effect.gen(function*() {
 *     for (let i = 0; i < config.count; i++) {
 *       yield* Console.log(`Hello, ${config.name}!`)
 *     }
 *   }))
 *
 * // Test with specific arguments
 * const testProgram = Effect.gen(function*() {
 *   const runCommand = Command.runWith(greet, { version: "1.0.0" })
 *
 *   // Test normal execution
 *   yield* runCommand(["--name", "Alice", "--count", "2"])
 *
 *   // Test help display
 *   yield* runCommand(["--help"])
 *
 *   // Test version display
 *   yield* runCommand(["--version"])
 * })
 * ```
 *
 * @since 4.0.0
 * @category command execution
 */
export const runWith = <const Name extends string, Input, E, R, ContextInput>(
  command: Command<Name, Input, ContextInput, E, R>,
  config: {
    readonly version: string
  }
): (
  input: ReadonlyArray<string>
) => Effect.Effect<void, Exclude<E, Terminal.QuitError> | CliError.CliError, R | Environment> => {
  const commandImpl = toImpl(command)
  return Effect.fnUntraced(
    function*(args: ReadonlyArray<string>) {
      const { tokens, trailingOperands } = Lexer.lex(args)

      // 1. Collect known global flags from the command tree
      const allFlags = getGlobalFlagsForCommandTree(command, GlobalFlag.BuiltIns)

      // 2. Extract global flag tokens
      const allFlagParams = allFlags.flatMap((f) => Param.extractSingleParams(f.flag))
      const globalRegistry = Parser.createFlagRegistry(allFlagParams.filter(Param.isFlagParam))
      const { flagMap, remainder, errors: globalFlagErrors } = Parser.consumeKnownFlags(tokens, globalRegistry)
      const emptyArgs: Param.ParsedArgs = { flags: flagMap, arguments: [] }

      // 3. Parse command arguments from remaining tokens
      const parsedArgs = yield* Parser.parseArgs({ tokens: remainder, trailingOperands }, command)
      const commandPath = [command.name, ...Parser.getCommandPath(parsedArgs)] as const
      const handlerCtx: GlobalFlag.HandlerContext = { command, commandPath, version: config.version }
      const activeFlags = getGlobalFlagsForCommandPath(command, commandPath, GlobalFlag.BuiltIns)

      // 4. Reject globals that were passed outside the active command scope
      const outOfScopeErrors = getOutOfScopeGlobalFlagErrors(allFlags, activeFlags, flagMap, commandPath)
      if (outOfScopeErrors.length > 0 || globalFlagErrors.length > 0) {
        const parseErrors = parsedArgs.errors ?? []
        return yield* new CliError.ShowHelp({
          commandPath,
          errors: [...globalFlagErrors, ...outOfScopeErrors, ...parseErrors]
        })
      }

      // 5. Process action flags — first present action wins, then exit
      for (const flag of activeFlags) {
        if (flag._tag !== "Action") continue
        const singles = Param.extractSingleParams(flag.flag)
        const hasEntry = singles.some((s) => {
          const entries = flagMap[s.name]
          return entries !== undefined && entries.length > 0
        })
        if (!hasEntry) continue
        const [, value] = yield* flag.flag.parse(emptyArgs)
        yield* flag.run(value, handlerCtx)
        return
      }

      // 6. Handle parsing errors
      if (parsedArgs.errors && parsedArgs.errors.length > 0) {
        return yield* new CliError.ShowHelp({ commandPath, errors: parsedArgs.errors })
      }
      const parseResult = yield* Effect.result(commandImpl.parse(parsedArgs))
      if (parseResult._tag === "Failure") {
        return yield* new CliError.ShowHelp({
          commandPath,
          errors: [parseResult.failure as CliError.NonShowHelpErrors]
        })
      }

      // 7. Provide setting values
      let program = commandImpl.handle(parseResult.success, [command.name])
      for (const flag of activeFlags) {
        if (flag._tag !== "Setting") continue
        const [, value] = yield* flag.flag.parse(emptyArgs)
        program = Effect.provideService(program, flag, value)
      }

      const [, logLevel] = yield* GlobalFlag.LogLevel.flag.parse(emptyArgs)
      program = Effect.provideService(program, GlobalFlag.LogLevel, logLevel)

      // 8. Apply built-in setting behavior
      const services = Option.match(logLevel, {
        onNone: () => Context.empty(),
        onSome: (level) => Context.make(References.MinimumLogLevel, level)
      })

      // 9. Run command handler with composed context
      yield* Effect.provideContext(program, services)
    },
    Effect.catchFilter(
      (error) =>
        CliError.isCliError(error) && error._tag === "ShowHelp"
          ? Result.succeed(error)
          : Result.fail(error),
      (error) => Effect.andThen(showHelp(command, error), Effect.fail(error))
    ),
    Effect.catchFilter(
      (e) =>
        Terminal.isQuitError(e)
          ? Result.succeed(e)
          : Result.fail(e as CliError.CliError | Exclude<E, Terminal.QuitError>),
      (_) => Effect.interrupt
    )
  )
}
