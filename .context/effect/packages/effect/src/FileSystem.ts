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
import * as Arr from "./Array.ts"
import * as Brand from "./Brand.ts"
import * as Cause from "./Cause.ts"
import * as Context from "./Context.ts"
import * as Effect from "./Effect.ts"
import { pipe } from "./Function.ts"
import * as Layer from "./Layer.ts"
import * as Option from "./Option.ts"
import { badArgument, type PlatformError, systemError } from "./PlatformError.ts"
import { hasProperty } from "./Predicate.ts"
import type * as Pull from "./Pull.ts"
import type { Scope } from "./Scope.ts"
import * as Sink from "./Sink.ts"
import * as Stream from "./Stream.ts"

const TypeId = "~effect/platform/FileSystem"

/**
 * Core interface for file system operations in Effect.
 *
 * The FileSystem interface provides a comprehensive set of file and directory operations
 * that work cross-platform. All operations return Effect values that can be composed,
 * transformed, and executed safely with proper error handling.
 *
 * @example
 * ```ts
 * import { Console, Effect, FileSystem } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const fs = yield* FileSystem.FileSystem
 *
 *   // Basic file operations
 *   const exists = yield* fs.exists("./config.json")
 *   if (!exists) {
 *     yield* fs.writeFileString("./config.json", "{\"env\": \"development\"}")
 *   }
 *
 *   // Directory operations
 *   yield* fs.makeDirectory("./logs", { recursive: true })
 *
 *   // File information
 *   const stats = yield* fs.stat("./config.json")
 *   yield* Console.log(`File size: ${stats.size} bytes`)
 *
 *   // Streaming operations
 *   const content = yield* fs.readFileString("./config.json")
 *   yield* Console.log("Config:", content)
 * })
 * ```
 *
 * @since 4.0.0
 * @category model
 */
export interface FileSystem {
  readonly [TypeId]: typeof TypeId

  /**
   * Check if a file can be accessed.
   * You can optionally specify the level of access to check for.
   */
  readonly access: (
    path: string,
    options?: {
      readonly ok?: boolean | undefined
      readonly readable?: boolean | undefined
      readonly writable?: boolean | undefined
    }
  ) => Effect.Effect<void, PlatformError>
  /**
   * Copy a file or directory from `fromPath` to `toPath`.
   *
   * Equivalent to `cp -r`.
   */
  readonly copy: (
    fromPath: string,
    toPath: string,
    options?: {
      readonly overwrite?: boolean | undefined
      readonly preserveTimestamps?: boolean | undefined
    }
  ) => Effect.Effect<void, PlatformError>
  /**
   * Copy a file from `fromPath` to `toPath`.
   */
  readonly copyFile: (
    fromPath: string,
    toPath: string
  ) => Effect.Effect<void, PlatformError>
  /**
   * Change the permissions of a file.
   */
  readonly chmod: (
    path: string,
    mode: number
  ) => Effect.Effect<void, PlatformError>
  /**
   * Change the owner and group of a file.
   */
  readonly chown: (
    path: string,
    uid: number,
    gid: number
  ) => Effect.Effect<void, PlatformError>
  /**
   * Check if a path exists.
   */
  readonly exists: (
    path: string
  ) => Effect.Effect<boolean, PlatformError>
  /**
   * Create a hard link from `fromPath` to `toPath`.
   */
  readonly link: (
    fromPath: string,
    toPath: string
  ) => Effect.Effect<void, PlatformError>
  /**
   * Create a directory at `path`. You can optionally specify the mode and
   * whether to recursively create nested directories.
   */
  readonly makeDirectory: (
    path: string,
    options?: {
      readonly recursive?: boolean | undefined
      readonly mode?: number | undefined
    }
  ) => Effect.Effect<void, PlatformError>
  /**
   * Create a temporary directory.
   *
   * By default the directory will be created inside the system's default
   * temporary directory, but you can specify a different location by setting
   * the `directory` option.
   *
   * You can also specify a prefix for the directory name by setting the
   * `prefix` option.
   */
  readonly makeTempDirectory: (options?: {
    readonly directory?: string | undefined
    readonly prefix?: string | undefined
  }) => Effect.Effect<string, PlatformError>
  /**
   * Create a temporary directory inside a scope.
   *
   * Functionally equivalent to `makeTempDirectory`, but the directory will be
   * automatically deleted when the scope is closed.
   */
  readonly makeTempDirectoryScoped: (options?: {
    readonly directory?: string | undefined
    readonly prefix?: string | undefined
  }) => Effect.Effect<string, PlatformError, Scope>
  /**
   * Create a temporary file.
   * The directory creation is functionally equivalent to `makeTempDirectory`.
   * The file name will be a randomly generated string.
   */
  readonly makeTempFile: (options?: {
    readonly directory?: string | undefined
    readonly prefix?: string | undefined
    readonly suffix?: string | undefined
  }) => Effect.Effect<string, PlatformError>
  /**
   * Create a temporary file inside a scope.
   *
   * Functionally equivalent to `makeTempFile`, but the file will be
   * automatically deleted when the scope is closed.
   */
  readonly makeTempFileScoped: (options?: {
    readonly directory?: string | undefined
    readonly prefix?: string | undefined
    readonly suffix?: string | undefined
  }) => Effect.Effect<string, PlatformError, Scope>
  /**
   * Open a file at `path` with the specified `options`.
   *
   * The file handle will be automatically closed when the scope is closed.
   */
  readonly open: (
    path: string,
    options?: {
      readonly flag?: OpenFlag | undefined
      readonly mode?: number | undefined
    }
  ) => Effect.Effect<File, PlatformError, Scope>
  /**
   * List the contents of a directory.
   *
   * You can recursively list the contents of nested directories by setting the
   * `recursive` option.
   */
  readonly readDirectory: (
    path: string,
    options?: {
      readonly recursive?: boolean | undefined
    }
  ) => Effect.Effect<Array<string>, PlatformError>
  /**
   * Read the contents of a file.
   */
  readonly readFile: (
    path: string
  ) => Effect.Effect<Uint8Array, PlatformError>
  /**
   * Read the contents of a file.
   */
  readonly readFileString: (
    path: string,
    encoding?: string
  ) => Effect.Effect<string, PlatformError>
  /**
   * Read the destination of a symbolic link.
   */
  readonly readLink: (
    path: string
  ) => Effect.Effect<string, PlatformError>
  /**
   * Resolve a path to its canonicalized absolute pathname.
   */
  readonly realPath: (
    path: string
  ) => Effect.Effect<string, PlatformError>
  /**
   * Remove a file or directory.
   */
  readonly remove: (
    path: string,
    options?: {
      /**
       * When `true`, you can recursively remove nested directories.
       */
      readonly recursive?: boolean | undefined
      /**
       * When `true`, exceptions will be ignored if `path` does not exist.
       */
      readonly force?: boolean | undefined
    }
  ) => Effect.Effect<void, PlatformError>
  /**
   * Rename a file or directory.
   */
  readonly rename: (
    oldPath: string,
    newPath: string
  ) => Effect.Effect<void, PlatformError>
  /**
   * Create a writable `Sink` for the specified `path`.
   */
  readonly sink: (
    path: string,
    options?: {
      readonly flag?: OpenFlag | undefined
      readonly mode?: number | undefined
    }
  ) => Sink.Sink<void, Uint8Array, never, PlatformError>
  /**
   * Get information about a file at `path`.
   */
  readonly stat: (
    path: string
  ) => Effect.Effect<File.Info, PlatformError>
  /**
   * Create a readable `Stream` for the specified `path`.
   *
   * Changing the `bufferSize` option will change the internal buffer size of
   * the stream. It defaults to `4`.
   *
   * The `chunkSize` option will change the size of the chunks emitted by the
   * stream. It defaults to 64kb.
   *
   * Changing `offset` and `bytesToRead` will change the offset and the number
   * of bytes to read from the file.
   */
  readonly stream: (
    path: string,
    options?: {
      readonly bytesToRead?: SizeInput | undefined
      readonly chunkSize?: SizeInput | undefined
      readonly offset?: SizeInput | undefined
    }
  ) => Stream.Stream<Uint8Array, PlatformError>
  /**
   * Create a symbolic link from `fromPath` to `toPath`.
   */
  readonly symlink: (
    fromPath: string,
    toPath: string
  ) => Effect.Effect<void, PlatformError>
  /**
   * Truncate a file to a specified length. If the `length` is not specified,
   * the file will be truncated to length `0`.
   */
  readonly truncate: (
    path: string,
    length?: SizeInput
  ) => Effect.Effect<void, PlatformError>
  /**
   * Change the file system timestamps of the file at `path`.
   */
  readonly utimes: (
    path: string,
    atime: Date | number,
    mtime: Date | number
  ) => Effect.Effect<void, PlatformError>
  /**
   * Watch a directory or file for changes
   */
  readonly watch: (path: string) => Stream.Stream<WatchEvent, PlatformError>
  /**
   * Write data to a file at `path`.
   */
  readonly writeFile: (
    path: string,
    data: Uint8Array,
    options?: {
      readonly flag?: OpenFlag | undefined
      readonly mode?: number | undefined
    }
  ) => Effect.Effect<void, PlatformError>
  /**
   * Write a string to a file at `path`.
   */
  readonly writeFileString: (
    path: string,
    data: string,
    options?: {
      readonly flag?: OpenFlag | undefined
      readonly mode?: number | undefined
    }
  ) => Effect.Effect<void, PlatformError>
}

/**
 * Represents a file size in bytes using a branded bigint.
 *
 * This type ensures type safety when working with file sizes, preventing
 * accidental mixing of regular numbers with size values. The underlying
 * bigint allows for handling very large file sizes beyond JavaScript's
 * number precision limits.
 *
 * @example
 * ```ts
 * import { Effect, FileSystem } from "effect"
 *
 * // Create sizes using the Size constructor
 * const smallFile = FileSystem.Size(1024) // 1 KB
 * const largeFile = FileSystem.Size(BigInt("9007199254740992")) // Very large
 *
 * // Use with file operations
 * const truncateToSize = (path: string, size: FileSystem.Size) =>
 *   Effect.gen(function*() {
 *     const fs = yield* FileSystem.FileSystem
 *     return fs.truncate(path, size)
 *   })
 * ```
 *
 * @since 4.0.0
 * @category sizes
 */
export type Size = Brand.Branded<bigint, "Size">

/**
 * Input type for size parameters that accepts multiple numeric types.
 *
 * This union type allows file system operations to accept size values in
 * different formats for convenience, which are then normalized to the
 * branded `Size` type internally.
 *
 * @example
 * ```ts
 * import { Effect, FileSystem } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const fs = yield* FileSystem.FileSystem
 *
 *   // All of these are valid SizeInput values
 *   yield* fs.truncate("file1.txt", 1024) // number
 *   yield* fs.truncate("file2.txt", BigInt(2048)) // bigint
 *   yield* fs.truncate("file3.txt", FileSystem.Size(4096)) // Size
 * })
 * ```
 *
 * @since 4.0.0
 * @category sizes
 */
export type SizeInput = bigint | number | Size

/**
 * Creates a `Size` from various numeric input types.
 *
 * Converts numbers, bigints, or existing Size values into a properly
 * branded Size type. This function handles the conversion and ensures
 * type safety for file size operations.
 *
 * @example
 * ```ts
 * import { Effect, FileSystem } from "effect"
 *
 * // From number
 * const size1 = FileSystem.Size(1024)
 * console.log(typeof size1) // "bigint"
 *
 * // From bigint
 * const size2 = FileSystem.Size(BigInt(2048))
 *
 * // From existing Size (identity)
 * const size3 = FileSystem.Size(size1)
 *
 * // Use in file operations
 * const readChunk = (path: string, chunkSize: number) =>
 *   Effect.gen(function*() {
 *     const fs = yield* FileSystem.FileSystem
 *     return fs.stream(path, {
 *       chunkSize: FileSystem.Size(chunkSize)
 *     })
 *   })
 * ```
 *
 * @since 4.0.0
 * @category sizes
 */
export const Size = (bytes: SizeInput): Size => typeof bytes === "bigint" ? bytes as Size : BigInt(bytes) as Size

/**
 * Creates a `Size` representing kilobytes (1024 bytes).
 *
 * Converts a number of kilobytes to the equivalent size in bytes.
 * Uses binary kilobytes (1024 bytes) rather than decimal (1000 bytes).
 *
 * @example
 * ```ts
 * import { Effect, FileSystem } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const fs = yield* FileSystem.FileSystem
 *
 *   // Create a 64 KiB buffer size for streaming
 *   const bufferSize = FileSystem.KiB(64)
 *
 *   const stream = fs.stream("large-file.txt", {
 *     chunkSize: bufferSize
 *   })
 *
 *   // Truncate file to 100 KiB
 *   yield* fs.truncate("data.txt", FileSystem.KiB(100))
 * })
 * ```
 *
 * @since 4.0.0
 * @category sizes
 */
export const KiB = (n: number): Size => Size(n * 1024)

/**
 * Creates a `Size` representing mebibytes (1024² bytes).
 *
 * Converts a number of mebibytes to the equivalent size in bytes.
 * Uses binary mebibytes (1,048,576 bytes) rather than decimal megabytes.
 *
 * @example
 * ```ts
 * import { Effect, FileSystem } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const fs = yield* FileSystem.FileSystem
 *
 *   // Set a 10 MiB chunk size for large file operations
 *   const largeChunkSize = FileSystem.MiB(10)
 *
 *   const stream = fs.stream("video.mp4", {
 *     chunkSize: largeChunkSize
 *   })
 *
 *   // Check if file is larger than 100 MiB
 *   const stats = yield* fs.stat("archive.zip")
 *   const maxSize = FileSystem.MiB(100)
 *   if (stats.size > maxSize) {
 *     yield* Effect.log("File is very large!")
 *   }
 * })
 * ```
 *
 * @since 4.0.0
 * @category sizes
 */
export const MiB = (n: number): Size => Size(n * 1024 * 1024)

/**
 * Creates a `Size` representing gibibytes (1024³ bytes).
 *
 * Converts a number of gibibytes to the equivalent size in bytes.
 * Uses binary gibibytes (1,073,741,824 bytes) rather than decimal gigabytes.
 *
 * @example
 * ```ts
 * import { Console, Effect, FileSystem } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const fs = yield* FileSystem.FileSystem
 *
 *   // Check available space before creating large files
 *   const stats = yield* fs.stat(".")
 *   const requiredSpace = FileSystem.GiB(5)
 *
 *   // Create a large temporary file
 *   const tempFile = yield* fs.makeTempFile({ prefix: "large-" })
 *   yield* fs.truncate(tempFile, FileSystem.GiB(1)) // 1 GiB file
 *
 *   yield* Console.log(`Created ${tempFile} with 1 GiB size`)
 * })
 * ```
 *
 * @since 4.0.0
 * @category sizes
 */
export const GiB = (n: number): Size => Size(n * 1024 * 1024 * 1024)

/**
 * Creates a `Size` representing tebibytes (1024⁴ bytes).
 *
 * Converts a number of tebibytes to the equivalent size in bytes.
 * Uses binary tebibytes (1,099,511,627,776 bytes) rather than decimal terabytes.
 *
 * @example
 * ```ts
 * import { Console, Effect, FileSystem } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const fs = yield* FileSystem.FileSystem
 *
 *   // Check if we're dealing with very large files
 *   const stats = yield* fs.stat("database-backup.sql")
 *   const oneTiB = FileSystem.TiB(1)
 *
 *   if (stats.size > oneTiB) {
 *     yield* Console.log("This is a very large database backup!")
 *
 *     // Use larger chunk sizes for such files
 *     const stream = fs.stream("database-backup.sql", {
 *       chunkSize: FileSystem.MiB(100) // 100 MiB chunks
 *     })
 *   }
 * })
 * ```
 *
 * @since 4.0.0
 * @category sizes
 */
export const TiB = (n: number): Size => Size(n * 1024 * 1024 * 1024 * 1024)

const bigint1024 = BigInt(1024)
const bigintPiB = bigint1024 * bigint1024 * bigint1024 * bigint1024 * bigint1024

/**
 * Creates a `Size` representing pebibytes (1024⁵ bytes).
 *
 * Converts a number of pebibytes to the equivalent size in bytes.
 * Uses binary pebibytes (1,125,899,906,842,624 bytes) rather than decimal petabytes.
 * This function uses BigInt arithmetic to handle the very large numbers involved.
 *
 * @example
 * ```ts
 * import { Console, Effect, FileSystem } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const fs = yield* FileSystem.FileSystem
 *
 *   // For extremely large data processing scenarios
 *   const massiveDataset = FileSystem.PiB(2) // 2 PiB
 *
 *   // This would typically be used in enterprise/cloud scenarios
 *   yield* Console.log(`Processing ${massiveDataset} bytes of data`)
 *
 *   // Such large files would require specialized streaming
 *   const stream = fs.stream("massive-dataset.bin", {
 *     chunkSize: FileSystem.GiB(1), // 1 GiB chunks
 *     offset: FileSystem.TiB(100) // Start from 100 TiB offset
 *   })
 * })
 * ```
 *
 * @since 4.0.0
 * @category sizes
 */
export const PiB = (n: number): Size => Size(BigInt(n) * bigintPiB)

/**
 * File open flags that determine how a file is opened and what operations are allowed.
 *
 * These flags correspond to standard POSIX file open modes and control the file access
 * permissions and behavior when opening files.
 *
 * - `"r"` - Read-only. File must exist.
 * - `"r+"` - Read/write. File must exist.
 * - `"w"` - Write-only. Truncates file to zero length or creates new file.
 * - `"wx"` - Like 'w' but fails if file exists.
 * - `"w+"` - Read/write. Truncates file to zero length or creates new file.
 * - `"wx+"` - Like 'w+' but fails if file exists.
 * - `"a"` - Write-only. Appends to file or creates new file.
 * - `"ax"` - Like 'a' but fails if file exists.
 * - `"a+"` - Read/write. Appends to file or creates new file.
 * - `"ax+"` - Like 'a+' but fails if file exists.
 *
 * @example
 * ```ts
 * import { Effect, FileSystem } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const fs = yield* FileSystem.FileSystem
 *
 *   // Open for reading only
 *   const readFile = yield* fs.open("data.txt", { flag: "r" })
 *
 *   // Open for writing, truncating existing content
 *   const writeFile = yield* fs.open("output.txt", { flag: "w" })
 *
 *   // Open for appending
 *   const appendFile = yield* fs.open("log.txt", { flag: "a" })
 *
 *   // Open for read/write, but fail if file doesn't exist
 *   const editFile = yield* fs.open("config.json", { flag: "r+" })
 * })
 * ```
 *
 * @since 4.0.0
 * @category model
 */
export type OpenFlag =
  | "r"
  | "r+"
  | "w"
  | "wx"
  | "w+"
  | "wx+"
  | "a"
  | "ax"
  | "a+"
  | "ax+"

/**
 * The service identifier for the FileSystem service.
 *
 * This key is used to provide and access the FileSystem service in the Effect context.
 * Use this to inject file system implementations or access file system operations.
 *
 * @example
 * ```ts
 * import { Effect, FileSystem } from "effect"
 *
 * // Access the FileSystem service
 * const program = Effect.gen(function*() {
 *   const fs = yield* FileSystem.FileSystem
 *
 *   const exists = yield* fs.exists("./data.txt")
 *   if (exists) {
 *     const content = yield* fs.readFileString("./data.txt")
 *     yield* Effect.log("File content:", content)
 *   }
 * })
 *
 * // Provide a custom FileSystem implementation
 * declare const platformImpl: Omit<
 *   FileSystem.FileSystem,
 *   "exists" | "readFileString" | "stream" | "sink" | "writeFileString"
 * >
 * const customFs = FileSystem.make(platformImpl)
 *
 * const withCustomFs = Effect.provideService(
 *   program,
 *   FileSystem.FileSystem,
 *   customFs
 * )
 * ```
 *
 * @since 4.0.0
 * @category tag
 */
export const FileSystem: Context.Service<FileSystem, FileSystem> = Context.Service("effect/platform/FileSystem")

/**
 * Creates a FileSystem implementation from a partial implementation.
 *
 * This function takes a partial FileSystem implementation and automatically provides
 * default implementations for `exists`, `readFileString`, `stream`, `sink`, and
 * `writeFileString` methods based on the provided core methods.
 *
 * @since 4.0.0
 * @category constructor
 */
export const make = (
  impl: Omit<FileSystem, typeof TypeId | "exists" | "readFileString" | "stream" | "sink" | "writeFileString">
): FileSystem =>
  FileSystem.of({
    ...impl,
    [TypeId]: TypeId,
    exists: (path) =>
      pipe(
        impl.access(path),
        Effect.as(true),
        Effect.catchTag(
          "PlatformError",
          (e) => e.reason._tag === "NotFound" ? Effect.succeed(false) : Effect.fail(e)
        )
      ),
    readFileString: (path, encoding) =>
      Effect.flatMap(impl.readFile(path), (_) =>
        Effect.try({
          try: () => new TextDecoder(encoding).decode(_),
          catch: (cause) =>
            badArgument({
              module: "FileSystem",
              method: "readFileString",
              description: "invalid encoding",
              cause
            })
        })),
    stream: Effect.fnUntraced(function*(path, options) {
      const file = yield* impl.open(path, { flag: "r" })
      if (options?.offset) {
        yield* file.seek(options.offset, "start")
      }
      const bytesToRead = options?.bytesToRead !== undefined ? Size(options.bytesToRead) : undefined
      let totalBytesRead = BigInt(0)
      const chunkSize = Size(options?.chunkSize ?? 64 * 1024)
      const readChunk = file.readAlloc(chunkSize)
      return Stream.fromPull(Effect.succeed(
        Effect.flatMap(
          Effect.suspend((): Pull.Pull<Option.Option<Uint8Array>, PlatformError> => {
            if (bytesToRead !== undefined && bytesToRead <= totalBytesRead) {
              return Cause.done()
            }
            return bytesToRead !== undefined && (bytesToRead - totalBytesRead) < chunkSize
              ? file.readAlloc(bytesToRead - totalBytesRead)
              : readChunk
          }),
          Option.match({
            onNone: () => Cause.done(),
            onSome: (buf) => {
              totalBytesRead += BigInt(buf.length)
              return Effect.succeed(Arr.of(buf))
            }
          })
        )
      ))
    }, Stream.unwrap),
    sink: (path, options) =>
      pipe(
        impl.open(path, { flag: "w", ...options }),
        Effect.map((file) => Sink.forEach((_: Uint8Array) => file.writeAll(_))),
        Sink.unwrap
      ),
    writeFileString: (path, data, options) =>
      Effect.flatMap(
        Effect.try({
          try: () => new TextEncoder().encode(data),
          catch: (cause) =>
            badArgument({
              module: "FileSystem",
              method: "writeFileString",
              description: "could not encode string",
              cause
            })
        }),
        (_) => impl.writeFile(path, _, options)
      )
  })

const notFound = (method: string, path: string) =>
  systemError({
    module: "FileSystem",
    method,
    _tag: "NotFound",
    description: "No such file or directory",
    pathOrDescriptor: path
  })

/**
 * Creates a no-op FileSystem implementation for testing purposes.
 *
 * This function creates a FileSystem where most operations fail with "NotFound" errors,
 * except for operations that can be safely stubbed. You can override specific methods
 * by providing them in the `fileSystem` parameter.
 *
 * This is useful for testing scenarios where you want to control specific file system
 * behaviors without affecting the actual file system.
 *
 * @example
 * ```ts
 * import { Effect, FileSystem, PlatformError } from "effect"
 *
 * // Create a test filesystem that only allows reading specific files
 * const testFs = FileSystem.makeNoop({
 *   readFileString: (path) => {
 *     if (path === "test-config.json") {
 *       return Effect.succeed("{\"test\": true}")
 *     }
 *     return Effect.fail(
 *       PlatformError.systemError({
 *         _tag: "NotFound",
 *         module: "FileSystem",
 *         method: "readFileString",
 *         description: "File not found",
 *         pathOrDescriptor: path
 *       })
 *     )
 *   },
 *   exists: (path) => Effect.succeed(path === "test-config.json")
 * })
 *
 * // Use in tests
 * const program = Effect.gen(function*() {
 *   const content = yield* testFs.readFileString("test-config.json")
 *   // Will succeed with mocked content
 * })
 *
 * // Test with the no-op filesystem
 * const testProgram = Effect.provideService(
 *   program,
 *   FileSystem.FileSystem,
 *   testFs
 * )
 * ```
 *
 * @since 4.0.0
 * @category constructor
 */
export const makeNoop = (fileSystem: Partial<FileSystem>): FileSystem =>
  FileSystem.of({
    [TypeId]: TypeId,
    access(path) {
      return Effect.fail(notFound("access", path))
    },
    chmod(path) {
      return Effect.fail(notFound("chmod", path))
    },
    chown(path) {
      return Effect.fail(notFound("chown", path))
    },
    copy(path) {
      return Effect.fail(notFound("copy", path))
    },
    copyFile(path) {
      return Effect.fail(notFound("copyFile", path))
    },
    exists() {
      return Effect.succeed(false)
    },
    link(path) {
      return Effect.fail(notFound("link", path))
    },
    makeDirectory() {
      return Effect.die("not implemented")
    },
    makeTempDirectory() {
      return Effect.die("not implemented")
    },
    makeTempDirectoryScoped() {
      return Effect.die("not implemented")
    },
    makeTempFile() {
      return Effect.die("not implemented")
    },
    makeTempFileScoped() {
      return Effect.die("not implemented")
    },
    open(path) {
      return Effect.fail(notFound("open", path))
    },
    readDirectory(path) {
      return Effect.fail(notFound("readDirectory", path))
    },
    readFile(path) {
      return Effect.fail(notFound("readFile", path))
    },
    readFileString(path) {
      return Effect.fail(notFound("readFileString", path))
    },
    readLink(path) {
      return Effect.fail(notFound("readLink", path))
    },
    realPath(path) {
      return Effect.fail(notFound("realPath", path))
    },
    remove() {
      return Effect.void
    },
    rename(oldPath) {
      return Effect.fail(notFound("rename", oldPath))
    },
    sink(path) {
      return Sink.fail(notFound("sink", path))
    },
    stat(path) {
      return Effect.fail(notFound("stat", path))
    },
    stream(path) {
      return Stream.fail(notFound("stream", path))
    },
    symlink(fromPath) {
      return Effect.fail(notFound("symlink", fromPath))
    },
    truncate(path) {
      return Effect.fail(notFound("truncate", path))
    },
    utimes(path) {
      return Effect.fail(notFound("utimes", path))
    },
    watch(path) {
      return Stream.fail(notFound("watch", path))
    },
    writeFile(path) {
      return Effect.fail(notFound("writeFile", path))
    },
    writeFileString(path) {
      return Effect.fail(notFound("writeFileString", path))
    },
    ...fileSystem
  })

/**
 * Creates a Layer that provides a no-op FileSystem implementation for testing.
 *
 * This is a convenience function that wraps `makeNoop` in a Layer, making it easy
 * to provide the test filesystem to your Effect programs.
 *
 * @example
 * ```ts
 * import { Effect, FileSystem } from "effect"
 *
 * // Create a test layer with specific behaviors
 * const testLayer = FileSystem.layerNoop({
 *   readFileString: (path) => Effect.succeed("mocked content"),
 *   exists: () => Effect.succeed(true)
 * })
 *
 * const program = Effect.gen(function*() {
 *   const fs = yield* FileSystem.FileSystem
 *   const content = yield* fs.readFileString("any-file.txt")
 *   return content
 * })
 *
 * // Provide the test layer
 * const testProgram = Effect.provide(program, testLayer)
 * ```
 *
 * @since 4.0.0
 * @category layers
 */
export const layerNoop = (fileSystem: Partial<FileSystem>): Layer.Layer<FileSystem> =>
  Layer.succeed(FileSystem)(makeNoop(fileSystem))

/**
 * @since 4.0.0
 * @category File
 */
export const FileTypeId = "~effect/platform/FileSystem/File"

/**
 * Type guard to check if a value is a File instance.
 *
 * This function determines whether the provided value is a valid File
 * instance by checking for the presence of the File type identifier.
 *
 * @since 4.0.0
 * @category File
 */
export const isFile = (u: unknown): u is File => hasProperty(u, FileTypeId)

/**
 * Interface representing an open file handle.
 *
 * Provides low-level file operations including reading, writing, seeking,
 * and retrieving file information. File handles are automatically managed
 * within scoped operations to ensure proper cleanup.
 *
 * @example
 * ```ts
 * import { Console, Effect, FileSystem } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const fs = yield* FileSystem.FileSystem
 *
 *   // Open a file and work with the handle
 *   yield* Effect.scoped(
 *     Effect.gen(function*() {
 *       const file = yield* fs.open("./data.txt", { flag: "r+" })
 *
 *       // Get file information
 *       const stats = yield* file.stat
 *       yield* Console.log(`File size: ${stats.size} bytes`)
 *
 *       // Read from specific position
 *       yield* file.seek(10, "start")
 *       const buffer = new Uint8Array(5)
 *       const bytesRead = yield* file.read(buffer)
 *       yield* Console.log(`Read ${bytesRead} bytes:`, buffer)
 *
 *       // Write data
 *       const data = new TextEncoder().encode("Hello")
 *       yield* file.write(data)
 *       yield* file.sync // Flush to disk
 *     })
 *   )
 * })
 * ```
 *
 * @since 4.0.0
 * @category File
 */
export interface File {
  readonly [FileTypeId]: typeof FileTypeId
  readonly fd: File.Descriptor
  readonly stat: Effect.Effect<File.Info, PlatformError>
  readonly seek: (offset: SizeInput, from: SeekMode) => Effect.Effect<void>
  readonly sync: Effect.Effect<void, PlatformError>
  readonly read: (buffer: Uint8Array) => Effect.Effect<Size, PlatformError>
  readonly readAlloc: (size: SizeInput) => Effect.Effect<Option.Option<Uint8Array>, PlatformError>
  readonly truncate: (length?: SizeInput) => Effect.Effect<void, PlatformError>
  readonly write: (buffer: Uint8Array) => Effect.Effect<Size, PlatformError>
  readonly writeAll: (buffer: Uint8Array) => Effect.Effect<void, PlatformError>
}

/**
 * @since 4.0.0
 * @category File
 */
export declare namespace File {
  /**
   * Branded type for file descriptors.
   *
   * File descriptors are numeric handles used by the operating system
   * to identify open files. The branded type ensures type safety.
   *
   * @since 4.0.0
   * @category File
   */
  export type Descriptor = Brand.Branded<number, "FileDescriptor">

  /**
   * Enumeration of possible file system entry types.
   *
   * Represents the different types of entries that can exist in a file system,
   * from regular files to special device files and symbolic links.
   *
   * @since 4.0.0
   * @category File
   */
  export type Type =
    | "File"
    | "Directory"
    | "SymbolicLink"
    | "BlockDevice"
    | "CharacterDevice"
    | "FIFO"
    | "Socket"
    | "Unknown"

  /**
   * Comprehensive file information structure.
   *
   * Contains metadata about a file or directory including type, timestamps,
   * permissions, and size information. This structure is returned by file
   * stat operations.
   *
   * @example
   * ```ts
   * import { Console, Effect, FileSystem, Option } from "effect"
   *
   * const program = Effect.gen(function*() {
   *   const fs = yield* FileSystem.FileSystem
   *
   *   const info: FileSystem.File.Info = yield* fs.stat("./data.txt")
   *
   *   yield* Console.log(`File type: ${info.type}`)
   *   yield* Console.log(`File size: ${info.size} bytes`)
   *   yield* Console.log(`Mode: ${info.mode.toString(8)}`) // Octal permissions
   *
   *   // Handle optional timestamps
   *   const mtime = Option.getOrElse(info.mtime, () => new Date(0))
   *   yield* Console.log(`Modified: ${mtime.toISOString()}`)
   *
   *   // Check if it's a regular file
   *   if (info.type === "File") {
   *     yield* Console.log("Processing regular file...")
   *   }
   * })
   * ```
   *
   * @since 4.0.0
   * @category File
   */
  export interface Info {
    readonly type: Type
    readonly mtime: Option.Option<Date>
    readonly atime: Option.Option<Date>
    readonly birthtime: Option.Option<Date>
    readonly dev: number
    readonly ino: Option.Option<number>
    readonly mode: number
    readonly nlink: Option.Option<number>
    readonly uid: Option.Option<number>
    readonly gid: Option.Option<number>
    readonly rdev: Option.Option<number>
    readonly size: Size
    readonly blksize: Option.Option<Size>
    readonly blocks: Option.Option<number>
  }
}

/**
 * Creates a branded file descriptor.
 *
 * File descriptors are integer handles that the operating system uses to identify
 * open files. This branded type ensures type safety when working with file descriptors.
 *
 * @since 4.0.0
 * @category constructor
 */
export const FileDescriptor = Brand.nominal<File.Descriptor>()

/**
 * Specifies the reference point for seeking within a file.
 *
 * - `"start"` - Seek from the beginning of the file
 * - `"current"` - Seek from the current position
 *
 * @since 4.0.0
 * @category model
 */
export type SeekMode = "start" | "current"

/**
 * Represents file system events that can be observed when watching files or directories.
 *
 * @since 4.0.0
 * @category model
 */
export type WatchEvent = WatchEvent.Create | WatchEvent.Update | WatchEvent.Remove

/**
 * @since 4.0.0
 * @category model
 */
export declare namespace WatchEvent {
  /**
   * Event representing the creation of a new file or directory.
   *
   * This event is triggered when a new file or directory is created
   * in the watched location.
   *
   * @since 4.0.0
   * @category model
   */
  export interface Create {
    readonly _tag: "Create"
    readonly path: string
  }

  /**
   * Event representing the modification of an existing file or directory.
   *
   * This event is triggered when an existing file or directory is
   * modified in the watched location.
   *
   * @since 4.0.0
   * @category model
   */
  export interface Update {
    readonly _tag: "Update"
    readonly path: string
  }

  /**
   * Event representing the deletion of a file or directory.
   *
   * This event is triggered when a file or directory is deleted
   * from the watched location.
   *
   * @since 4.0.0
   * @category model
   */
  export interface Remove {
    readonly _tag: "Remove"
    readonly path: string
  }
}

/**
 * Service key for file system watch backend implementations.
 *
 * This service provides the low-level file watching capabilities that can be
 * implemented differently on various platforms (e.g., inotify on Linux,
 * FSEvents on macOS, etc.).
 *
 * @example
 * ```ts
 * import { Effect, FileSystem, Option, Stream } from "effect"
 *
 * // Custom watch backend implementation
 * const customWatchBackend = {
 *   register: (path: string, stat: FileSystem.File.Info) => {
 *     // Implementation would depend on platform
 *     return Option.some(Stream.empty) // Placeholder implementation
 *   }
 * }
 *
 * // Provide custom watch backend
 * const program = Effect.gen(function*() {
 *   const fs = yield* FileSystem.FileSystem
 *
 *   // File watching will use the custom backend
 *   const watcher = fs.watch("./directory")
 * })
 *
 * const withCustomBackend = Effect.provideService(
 *   program,
 *   FileSystem.WatchBackend,
 *   customWatchBackend
 * )
 * ```
 *
 * @since 4.0.0
 * @category file watcher
 */
export class WatchBackend extends Context.Service<WatchBackend, {
  readonly register: (path: string, stat: File.Info) => Option.Option<Stream.Stream<WatchEvent, PlatformError>>
}>()("effect/platform/FileSystem/WatchBackend") {}
