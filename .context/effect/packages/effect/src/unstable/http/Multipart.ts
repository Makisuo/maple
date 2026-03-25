/**
 * @since 4.0.0
 */
import * as Arr from "../../Array.ts"
import * as Cause from "../../Cause.ts"
import * as Channel from "../../Channel.ts"
import * as Data from "../../Data.ts"
import * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import * as FileSystem from "../../FileSystem.ts"
import { constant, dual } from "../../Function.ts"
import * as Inspectable from "../../Inspectable.ts"
import * as Option from "../../Option.ts"
import * as Path from "../../Path.ts"
import * as Predicate from "../../Predicate.ts"
import * as Pull from "../../Pull.ts"
import * as Schema from "../../Schema.ts"
import type { ParseOptions } from "../../SchemaAST.ts"
import * as Transformation from "../../SchemaTransformation.ts"
import type * as Scope from "../../Scope.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import * as Stream from "../../Stream.ts"
import * as UndefinedOr from "../../UndefinedOr.ts"
import * as IncomingMessage from "./HttpIncomingMessage.ts"
import * as MP from "./Multipasta.ts"

/**
 * @since 4.0.0
 */
export const TypeId = "~effect/http/Multipart"

/**
 * @since 4.0.0
 * @category models
 */
export type Part = Field | File

/**
 * @since 4.0.0
 */
export declare namespace Part {
  /**
   * @since 4.0.0
   * @category models
   */
  export interface Proto extends Inspectable.Inspectable {
    readonly [TypeId]: typeof TypeId
    readonly _tag: string
  }
}

/**
 * @since 4.0.0
 * @category models
 */
export interface Field extends Part.Proto {
  readonly _tag: "Field"
  readonly key: string
  readonly contentType: string
  readonly value: string
}

/**
 * @since 4.0.0
 * @category Guards
 */
export const isPart = (u: unknown): u is Part => Predicate.hasProperty(u, TypeId)

/**
 * @since 4.0.0
 * @category Guards
 */
export const isField = (u: unknown): u is Field => isPart(u) && u._tag === "Field"

/**
 * @since 4.0.0
 * @category models
 */
export interface File extends Part.Proto {
  readonly _tag: "File"
  readonly key: string
  readonly name: string
  readonly contentType: string
  readonly content: Stream.Stream<Uint8Array, MultipartError>
  readonly contentEffect: Effect.Effect<Uint8Array, MultipartError>
}

/**
 * @since 4.0.0
 * @category Guards
 */
export const isFile = (u: unknown): u is File => isPart(u) && u._tag === "File"

/**
 * @since 4.0.0
 * @category models
 */
export interface PersistedFile extends Part.Proto {
  readonly _tag: "PersistedFile"
  readonly key: string
  readonly name: string
  readonly contentType: string
  readonly path: string
}

/**
 * @since 4.0.0
 * @category Guards
 */
export const isPersistedFile = (u: unknown): u is PersistedFile =>
  Predicate.hasProperty(u, TypeId) && Predicate.isTagged(u, "PersistedFile")

/**
 * @since 4.0.0
 * @category models
 */
export interface Persisted {
  readonly [key: string]: ReadonlyArray<PersistedFile> | ReadonlyArray<string> | string
}

const MultipartErrorTypeId = "~effect/http/Multipart/MultipartError"

/**
 * @since 4.0.0
 * @category Errors
 */
export class MultipartErrorReason extends Data.Error<{
  readonly _tag: "FileTooLarge" | "FieldTooLarge" | "BodyTooLarge" | "TooManyParts" | "InternalError" | "Parse"
  readonly cause?: unknown
}> {}

/**
 * @since 4.0.0
 * @category Errors
 */
export class MultipartError extends Data.TaggedError("MultipartError")<{
  readonly reason: MultipartErrorReason
}> {
  /**
   * @since 4.0.0
   */
  static fromReason(reason: MultipartErrorReason["_tag"], cause?: unknown): MultipartError {
    return new MultipartError({ reason: new MultipartErrorReason({ _tag: reason, cause }) })
  }

  /**
   * @since 4.0.0
   */
  readonly [MultipartErrorTypeId] = MultipartErrorTypeId

  /**
   * @since 4.0.0
   */
  override get message(): string {
    return this.reason._tag
  }
}

/**
 * @since 4.0.0
 * @category Schemas
 */
export interface PersistedFileSchema extends Schema.declare<PersistedFile> {}

/**
 * @since 4.0.0
 * @category Schemas
 */
export const PersistedFileSchema: PersistedFileSchema = Schema.declare(
  isPersistedFile,
  {
    typeConstructor: {
      _tag: "effect/http/PersistedFile"
    },
    generation: {
      runtime: `Multipart.PersistedFileSchema`,
      Type: `Multipart.PersistedFile`,
      importDeclaration: `import * as Multipart from "effect/unstable/http/Multipart"`
    },
    expected: "PersistedFile",
    toCodecJson: () =>
      Schema.link<PersistedFile>()(
        Schema.Struct({
          key: Schema.String,
          name: Schema.String,
          contentType: Schema.String.annotate({ contentEncoding: "binary" }),
          path: Schema.String
        }),
        Transformation.transform({
          decode: ({ contentType, key, name, path }) => new PersistedFileImpl(key, name, contentType, path),
          encode: (file) => ({
            key: file.key,
            name: file.name,
            contentType: file.contentType,
            path: file.path
          })
        })
      )
  }
)

/**
 * @since 4.0.0
 * @category Schemas
 */
export const FilesSchema: Schema.$Array<PersistedFileSchema> = Schema.Array(PersistedFileSchema)

/**
 * @since 4.0.0
 * @category Schemas
 */
export const SingleFileSchema: Schema.decodeTo<PersistedFileSchema, Schema.$Array<PersistedFileSchema>> = FilesSchema
  .check(
    Schema.isLengthBetween(1, 1)
  ).pipe(
    Schema.decodeTo(
      PersistedFileSchema,
      Transformation.transform({
        decode: ([file]) => file,
        encode: (file) => [file]
      })
    )
  )

/**
 * @since 4.0.0
 * @category Schemas
 */
export const schemaPersisted = <A, I extends Partial<Persisted>, RD, RE>(
  schema: Schema.Codec<A, I, RD, RE>
): (input: unknown, options?: ParseOptions) => Effect.Effect<A, Schema.SchemaError, RD> =>
  Schema.decodeUnknownEffect(schema)

/**
 * @since 4.0.0
 * @category Schemas
 */
export const schemaJson = <A, I, RD, RE>(schema: Schema.Codec<A, I, RD, RE>, options?: ParseOptions | undefined): {
  (
    field: string
  ): (persisted: Persisted) => Effect.Effect<A, Schema.SchemaError, RD>
  (
    persisted: Persisted,
    field: string
  ): Effect.Effect<A, Schema.SchemaError, RD>
} => {
  const fromJson = Schema.fromJsonString(schema)
  return dual(2, (persisted: Persisted, field: string): Effect.Effect<A, Schema.SchemaError, RD> =>
    Effect.map(
      Schema.decodeUnknownEffect(Schema.Struct({ [field]: fromJson }))(persisted, options),
      (_) => _[field]
    ))
}

/**
 * @since 4.0.0
 * @category Config
 */
export const makeConfig = (
  headers: Record<string, string>
): Effect.Effect<MP.BaseConfig> =>
  Effect.withFiber((fiber) => {
    const mimeTypes = ServiceMap.get(fiber.services, FieldMimeTypes)
    return Effect.succeed<MP.BaseConfig>({
      headers,
      maxParts: fiber.getRef(MaxParts),
      maxFieldSize: Number(fiber.getRef(MaxFieldSize)),
      maxPartSize: UndefinedOr.map(fiber.getRef(MaxFileSize), Number),
      maxTotalSize: UndefinedOr.map(fiber.getRef(IncomingMessage.MaxBodySize), Number),
      isFile: mimeTypes.length === 0 ? undefined : (info: MP.PartInfo): boolean =>
        !mimeTypes.some(
          (_) => info.contentType.includes(_)
        ) && MP.defaultIsFile(info)
    })
  })

/**
 * @since 4.0.0
 * @category Parsers
 */
export const makeChannel = <IE>(headers: Record<string, string>): Channel.Channel<
  Arr.NonEmptyReadonlyArray<Part>,
  MultipartError | IE,
  void,
  Arr.NonEmptyReadonlyArray<Uint8Array>,
  IE,
  unknown
> =>
  Channel.fromTransform((upstream) =>
    Effect.map(makeConfig(headers), (config) => {
      let partsBuffer: Array<Part> = []
      let exit = Option.none<Exit.Exit<never, IE | MultipartError | Cause.Done>>()

      const parser = MP.make({
        ...config,
        onField(info, value) {
          partsBuffer.push(new FieldImpl(info.name, info.contentType, MP.decodeField(info, value)))
        },
        onFile(info) {
          let chunks: Array<Uint8Array> = []
          let finished = false
          const pullChunks = Channel.fromPull(
            Effect.succeed(Effect.suspend(function loop(): Pull.Pull<Arr.NonEmptyReadonlyArray<Uint8Array>> {
              if (!Arr.isReadonlyArrayNonEmpty(chunks)) {
                return finished ? Cause.done() : Effect.flatMap(pump, loop)
              }
              const chunk = chunks
              chunks = []
              return Effect.succeed(chunk)
            }))
          )
          partsBuffer.push(new FileImpl(info, pullChunks))
          return function(chunk) {
            if (chunk === null) {
              finished = true
            } else {
              chunks.push(chunk)
            }
          }
        },
        onError(error_) {
          exit = Option.some(Exit.fail(convertError(error_)))
        },
        onDone() {
          exit = Option.some(Exit.fail(Cause.Done()))
        }
      })

      const pump = upstream.pipe(
        Effect.flatMap((chunk) => {
          for (let i = 0; i < chunk.length; i++) {
            parser.write(chunk[i])
          }
          return Effect.void
        }),
        Effect.catchCause((cause) => {
          if (Pull.isDoneCause(cause)) {
            parser.end()
          } else {
            exit = Option.some(Exit.failCause(cause)) as any
          }
          return Effect.void
        })
      )

      return pump.pipe(
        Effect.flatMap(function loop(): Pull.Pull<Arr.NonEmptyReadonlyArray<Part>, IE | MultipartError> {
          if (!Arr.isReadonlyArrayNonEmpty(partsBuffer)) {
            if (Option.isSome(exit)) {
              return exit.value
            }
            return Effect.flatMap(pump, loop)
          }
          const parts = partsBuffer
          partsBuffer = []
          return Effect.succeed(parts)
        })
      )
    })
  )

function convertError(cause: MP.MultipartError): MultipartError {
  switch (cause._tag) {
    case "ReachedLimit": {
      switch (cause.limit) {
        case "MaxParts": {
          return MultipartError.fromReason("TooManyParts", cause)
        }
        case "MaxFieldSize": {
          return MultipartError.fromReason("FieldTooLarge", cause)
        }
        case "MaxPartSize": {
          return MultipartError.fromReason("FileTooLarge", cause)
        }
        case "MaxTotalSize": {
          return MultipartError.fromReason("BodyTooLarge", cause)
        }
      }
    }
    default: {
      return MultipartError.fromReason("Parse", cause)
    }
  }
}

abstract class PartBase extends Inspectable.Class {
  readonly [TypeId]: typeof TypeId
  constructor() {
    super()
    this[TypeId] = TypeId
  }
}

class FieldImpl extends PartBase implements Field {
  readonly _tag = "Field"
  readonly key: string
  readonly contentType: string
  readonly value: string

  constructor(
    key: string,
    contentType: string,
    value: string
  ) {
    super()
    this.key = key
    this.contentType = contentType
    this.value = value
  }

  toJSON(): unknown {
    return {
      _id: "@effect/platform/Multipart/Part",
      _tag: "Field",
      key: this.key,
      contentType: this.contentType,
      value: this.value
    }
  }
}

class FileImpl extends PartBase implements File {
  readonly _tag = "File"
  readonly key: string
  readonly name: string
  readonly contentType: string
  readonly content: Stream.Stream<Uint8Array, MultipartError>
  readonly contentEffect: Effect.Effect<Uint8Array, MultipartError>

  constructor(
    info: MP.PartInfo,
    channel: Channel.Channel<Arr.NonEmptyReadonlyArray<Uint8Array>>
  ) {
    super()
    this.key = info.name
    this.name = info.filename ?? info.name
    this.contentType = info.contentType
    this.content = Stream.fromChannel(channel)
    this.contentEffect = channel.pipe(
      collectUint8Array,
      Effect.mapError((cause) => MultipartError.fromReason("InternalError", cause))
    )
  }

  toJSON(): unknown {
    return {
      _id: "@effect/platform/Multipart/Part",
      _tag: "File",
      key: this.key,
      name: this.name,
      contentType: this.contentType
    }
  }
}

const defaultWriteFile = (path: string, file: File) =>
  Effect.flatMap(
    FileSystem.FileSystem.asEffect(),
    (fs) =>
      Effect.mapError(
        Stream.run(file.content, fs.sink(path)),
        (cause) => MultipartError.fromReason("InternalError", cause)
      )
  )

/**
 * @since 4.0.0
 */
export const collectUint8Array = <OE, OD, R>(
  self: Channel.Channel<Arr.NonEmptyReadonlyArray<Uint8Array>, OE, OD, unknown, unknown, unknown, R>
): Effect.Effect<Uint8Array<ArrayBuffer>, OE, R> =>
  Channel.runFold(self, constant(new Uint8Array(0)), (accumulator, chunk) => {
    const totalLength = chunk.reduce((sum, element) => sum + element.length, accumulator.length)
    const newAccumulator = new Uint8Array(totalLength)
    newAccumulator.set(accumulator, 0)
    let offset = accumulator.length
    for (const element of chunk) {
      newAccumulator.set(element, offset)
      offset += element.length
    }
    return newAccumulator
  })

/**
 * @since 4.0.0
 * @category Conversions
 */
export const toPersisted = (
  stream: Stream.Stream<Part, MultipartError>,
  writeFile = defaultWriteFile
): Effect.Effect<Persisted, MultipartError, FileSystem.FileSystem | Path.Path | Scope.Scope> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path_ = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped()
    const persisted: Record<string, Array<PersistedFile> | Array<string> | string> = Object.create(null)
    yield* Stream.runForEach(stream, (part) => {
      if (part._tag === "Field") {
        if (!(part.key in persisted)) {
          persisted[part.key] = part.value
        } else if (typeof persisted[part.key] === "string") {
          persisted[part.key] = [persisted[part.key] as string, part.value]
        } else {
          ;(persisted[part.key] as Array<string>).push(part.value)
        }
        return Effect.void
      } else if (part.name === "") {
        return Effect.void
      }
      const file = part
      const path = path_.join(dir, path_.basename(file.name).slice(-128))
      const filePart = new PersistedFileImpl(
        file.key,
        file.name,
        file.contentType,
        path
      )
      if (Array.isArray(persisted[part.key])) {
        ;(persisted[part.key] as Array<PersistedFile>).push(filePart)
      } else {
        persisted[part.key] = [filePart]
      }
      return writeFile(path, file)
    })
    return persisted
  }).pipe(
    Effect.catchTag("PlatformError", (cause) => Effect.fail(MultipartError.fromReason("InternalError", cause)))
  )

class PersistedFileImpl extends PartBase implements PersistedFile {
  readonly _tag = "PersistedFile"
  readonly key: string
  readonly name: string
  readonly contentType: string
  readonly path: string

  constructor(
    key: string,
    name: string,
    contentType: string,
    path: string
  ) {
    super()
    this.key = key
    this.name = name
    this.contentType = contentType
    this.path = path
  }

  toJSON(): unknown {
    return {
      _id: "@effect/platform/Multipart/Part",
      _tag: "PersistedFile",
      key: this.key,
      name: this.name,
      contentType: this.contentType,
      path: this.path
    }
  }
}

/**
 * @since 4.0.0
 * @category References
 */
export const limitsServices = (options: {
  readonly maxParts?: number | undefined
  readonly maxFieldSize?: FileSystem.SizeInput | undefined
  readonly maxFileSize?: FileSystem.SizeInput | undefined
  readonly maxTotalSize?: FileSystem.SizeInput | undefined
  readonly fieldMimeTypes?: ReadonlyArray<string> | undefined
}): ServiceMap.ServiceMap<never> => {
  const map = new Map<string, unknown>()
  if (options.maxParts !== undefined) {
    map.set(MaxParts.key, options.maxParts)
  }
  if (options.maxFieldSize !== undefined) {
    map.set(MaxFieldSize.key, FileSystem.Size(options.maxFieldSize))
  }
  if (options.maxFileSize !== undefined) {
    map.set(MaxFileSize.key, UndefinedOr.map(options.maxFileSize, FileSystem.Size))
  }
  if (options.maxTotalSize !== undefined) {
    map.set(IncomingMessage.MaxBodySize.key, UndefinedOr.map(options.maxTotalSize, FileSystem.Size))
  }
  if (options.fieldMimeTypes !== undefined) {
    map.set(FieldMimeTypes.key, options.fieldMimeTypes)
  }
  return ServiceMap.makeUnsafe(map)
}

/**
 * @since 4.0.0
 * @category fiber refs
 */
export declare namespace withLimits {
  /**
   * @since 4.0.0
   * @category fiber refs
   */
  export type Options = {
    readonly maxParts?: number | undefined
    readonly maxFieldSize?: FileSystem.SizeInput | undefined
    readonly maxFileSize?: FileSystem.SizeInput | undefined
    readonly maxTotalSize?: FileSystem.SizeInput | undefined
    readonly fieldMimeTypes?: ReadonlyArray<string> | undefined
  }
}

/**
 * @since 4.0.0
 * @category References
 */
export const MaxParts = ServiceMap.Reference<number | undefined>("effect/http/Multipart/MaxParts", {
  defaultValue: () => undefined
})

/**
 * @since 4.0.0
 * @category References
 */
export const MaxFieldSize = ServiceMap.Reference<FileSystem.SizeInput>("effect/http/Multipart/MaxFieldSize", {
  defaultValue: constant(FileSystem.Size(10 * 1024 * 1024))
})

/**
 * @since 4.0.0
 * @category References
 */
export const MaxFileSize = ServiceMap.Reference<FileSystem.SizeInput | undefined>(
  "effect/http/Multipart/MaxFileSize",
  { defaultValue: () => undefined }
)

/**
 * @since 4.0.0
 * @category References
 */
export const FieldMimeTypes = ServiceMap.Reference<ReadonlyArray<string>>("effect/http/Multipart/FieldMimeTypes", {
  defaultValue: constant(["application/json"])
})
