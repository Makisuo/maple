/**
 * A module providing a generic service interface for spawning child processes.
 *
 * This module provides the `ChildProcessSpawner` service tag which can be
 * implemented by platform-specific packages (e.g., Node.js).
 *
 * @since 4.0.0
 */
import * as Brand from "../../Brand.ts"
import * as Effect from "../../Effect.ts"
import * as Inspectable from "../../Inspectable.ts"
import type * as PlatformError from "../../PlatformError.ts"
import type * as Scope from "../../Scope.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import type * as Sink from "../../Sink.ts"
import * as Stream from "../../Stream.ts"
import type { Command, KillOptions } from "./ChildProcess.ts"

/**
 * @since 4.0.0
 * @category Models
 */
export type ExitCode = Brand.Branded<number, "ExitCode">

/**
 * @since 4.0.0
 * @category Constructors
 */
export const ExitCode: Brand.Constructor<ExitCode> = Brand.nominal<ExitCode>()

/**
 * @since 4.0.0
 * @category Models
 */
export type ProcessId = Brand.Branded<number, "ProcessId">

/**
 * @since 4.0.0
 * @category Constructors
 */
export const ProcessId: Brand.Constructor<ProcessId> = Brand.nominal<ProcessId>()

const HandleTypeId = "~effect/ChildProcessSpawner/ChildProcessHandle"

/**
 * A handle to a running child process.
 *
 * @since 4.0.0
 * @category Models
 */
export interface ChildProcessHandle {
  readonly [HandleTypeId]: typeof HandleTypeId
  /**
   * The child process process identifier.
   */
  readonly pid: ProcessId
  /**
   * Waits for the child process to exit and returns the `ExitCode` of the
   * command that was run.
   */
  readonly exitCode: Effect.Effect<ExitCode, PlatformError.PlatformError>
  /**
   * Returns `true` if the child process is still running, otherwise returns
   * `false`.
   */
  readonly isRunning: Effect.Effect<boolean, PlatformError.PlatformError>
  /**
   * Kills the child process with the provided signal.
   *
   * If no signal option is provided, the signal defaults to `SIGTERM`.
   */
  readonly kill: (options?: KillOptions | undefined) => Effect.Effect<void, PlatformError.PlatformError>
  /**
   * The standard input sink for the child process.
   */
  readonly stdin: Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError>
  /**
   * The standard output stream for the child process.
   *
   * Note: Using alongside `all` may cause interleaving of output and unexpected
   * results.
   */
  readonly stdout: Stream.Stream<Uint8Array, PlatformError.PlatformError>
  /**
   * The standard error stream for the child process.
   *
   * Note: Using alongside `all` may cause interleaving of output and unexpected
   * results.
   */
  readonly stderr: Stream.Stream<Uint8Array, PlatformError.PlatformError>
  /**
   * A stream which combines and interleaves all messages output by the child
   * process `stdout` and `stderr` streams.
   */
  readonly all: Stream.Stream<Uint8Array, PlatformError.PlatformError>
  /**
   * Get an input `Sink` for writing to a file descriptor configured via
   * `ChildProcessOptions.additionalFds`.
   *
   * If a file descriptor is accessed that was not configured, returns a drain
   * `Sink`.
   */
  readonly getInputFd: (fd: number) => Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError>
  /**
   * Get an output `Stream` for reading from a file descriptor configured via
   * `ChildProcessOptions.additionalFds`.
   *
   * If a file descriptor is accessed that was not configured, returns an empty
   * `Stream`.
   */
  readonly getOutputFd: (fd: number) => Stream.Stream<Uint8Array, PlatformError.PlatformError>
}

const HandleProto = {
  [HandleTypeId]: HandleTypeId,
  ...Inspectable.BaseProto,
  toJSON(this: ChildProcessHandle) {
    return { _id: "ChildProcessHandle", pid: this.pid }
  }
}

/**
 * Constructs a new `ChildProcessHandle`.
 *
 * @since 4.0.0
 * @category Constructors
 */
export const makeHandle = (params: Omit<ChildProcessHandle, typeof HandleTypeId>): ChildProcessHandle =>
  Object.assign(Object.create(HandleProto), params)

/**
 * Create a new `ChildProcessSpawner` service from a `spawn` funciton
 *
 * @since 4.0.0
 * @category Models
 */
export const make = (spawn: ChildProcessSpawner["Service"]["spawn"]): ChildProcessSpawner["Service"] => {
  const streamString: ChildProcessSpawner["Service"]["streamLines"] = (command, options) =>
    spawn(command).pipe(
      Effect.map((handle) =>
        Stream.decodeText(
          options?.includeStderr === true ? handle.all : handle.stdout
        )
      ),
      Stream.unwrap
    )
  const streamLines: ChildProcessSpawner["Service"]["streamLines"] = (command, options) =>
    Stream.splitLines(streamString(command, options))

  return ChildProcessSpawner.of({
    spawn,
    exitCode: (command) => Effect.scoped(Effect.flatMap(spawn(command), (handle) => handle.exitCode)),
    streamString,
    streamLines,
    lines: (command, options) => Stream.runCollect(streamLines(command, options)),
    string: (command, options) => Stream.mkString(streamString(command, options))
  })
}

/**
 * Service tag for child process spawning.
 *
 * @since 4.0.0
 * @category Service
 */
export class ChildProcessSpawner extends ServiceMap.Service<ChildProcessSpawner, {
  /**
   * Spawn a command and return a handle for interaction.
   */
  spawn(
    command: Command
  ): Effect.Effect<ChildProcessHandle, PlatformError.PlatformError, Scope.Scope>

  /**
   * Run a command and return its exit code.
   */
  exitCode(
    command: Command
  ): Effect.Effect<ExitCode, PlatformError.PlatformError>

  /**
   * Stream the output of a command as strings. Optionally include stderr output
   * interleaved with stdout.
   */
  streamString(command: Command, options?: {
    readonly includeStderr?: boolean | undefined
  }): Stream.Stream<string, PlatformError.PlatformError>

  /**
   * Stream the output of a command as lines. Optionally include stderr output
   * interleaved with stdout.
   */
  streamLines(command: Command, options?: {
    readonly includeStderr?: boolean | undefined
  }): Stream.Stream<string, PlatformError.PlatformError>

  /**
   * Run a command and return the lines of its output as an array of strings.
   */
  lines(command: Command, options?: {
    readonly includeStderr?: boolean | undefined
  }): Effect.Effect<Array<string>, PlatformError.PlatformError>

  /**
   * Run a command and return its output as a string.
   */
  string(command: Command, options?: {
    readonly includeStderr?: boolean | undefined
  }): Effect.Effect<string, PlatformError.PlatformError>
}>()("effect/process/ChildProcessSpawner") {}
