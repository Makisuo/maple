/**
 * @since 4.0.0
 */
import * as Data from "../../Data.ts"
import * as Effect from "../../Effect.ts"
import * as FileSystem from "../../FileSystem.ts"
import { format } from "../../Formatter.ts"
import * as Inspectable from "../../Inspectable.ts"
import type * as PlatformError from "../../PlatformError.ts"
import * as Predicate from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"
import type { ParseOptions } from "../../SchemaAST.ts"
import type { Issue } from "../../SchemaIssue.ts"
import * as Parser from "../../SchemaParser.ts"
import type * as Stream_ from "../../Stream.ts"
import * as UrlParams from "./UrlParams.ts"

const TypeId = "~effect/http/HttpBody"

/**
 * @since 4.0.0
 * @category refinements
 */
export const isHttpBody = (u: unknown): u is HttpBody => Predicate.hasProperty(u, TypeId)

/**
 * @since 4.0.0
 * @category models
 */
export type HttpBody = Empty | Raw | Uint8Array | FormData | Stream

/**
 * @since 4.0.0
 */
export declare namespace HttpBody {
  /**
   * @since 4.0.0
   * @category models
   */
  export interface Proto extends Inspectable.Inspectable {
    readonly [TypeId]: typeof TypeId
    readonly _tag: string
    readonly contentType?: string | undefined
    readonly contentLength?: number | undefined
  }

  /**
   * @since 4.0.0
   * @category models
   */
  export interface FileLike {
    readonly name: string
    readonly lastModified: number
    readonly size: number
    readonly stream: () => unknown
    readonly type: string
  }
}

const HttpBodyErrorTypeId = "~effect/http/HttpBody/HttpBodyError"

/**
 * @since 4.0.0
 * @category errors
 */
export class HttpBodyError extends Data.TaggedError("HttpBodyError")<{
  readonly reason: ErrorReason
  readonly cause?: unknown
}> {
  /**
   * @since 4.0.0
   */
  readonly [HttpBodyErrorTypeId] = HttpBodyErrorTypeId
}

/**
 * @since 4.0.0
 * @category errors
 */
export type ErrorReason = {
  readonly _tag: "JsonError"
} | {
  readonly _tag: "SchemaError"
  readonly issue: Issue
}

abstract class Proto implements HttpBody.Proto {
  readonly [TypeId]: typeof TypeId
  abstract readonly _tag: string
  constructor() {
    this[TypeId] = TypeId
  }
  abstract toJSON(): unknown
  [Inspectable.NodeInspectSymbol](): unknown {
    return this.toJSON()
  }
  toString(): string {
    return format(this, { ignoreToString: true })
  }
}

/**
 * @since 4.0.0
 * @category models
 */
export class Empty extends Proto {
  readonly _tag = "Empty"
  toJSON(): unknown {
    return {
      _id: "effect/HttpBody",
      _tag: "Empty"
    }
  }
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const empty: Empty = new Empty()

/**
 * @since 4.0.0
 * @category models
 */
export class Raw extends Proto {
  readonly _tag = "Raw"
  readonly body: unknown
  readonly contentType: string | undefined
  readonly contentLength: number | undefined

  constructor(
    body: unknown,
    contentType: string | undefined,
    contentLength: number | undefined
  ) {
    super()
    this.body = body
    this.contentType = contentType
    this.contentLength = contentLength
  }
  toJSON(): unknown {
    return {
      _id: "effect/HttpBody",
      _tag: "Raw",
      body: this.body,
      contentType: this.contentType,
      contentLength: this.contentLength
    }
  }
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const raw = (
  body: unknown,
  options?: {
    readonly contentType?: string | undefined
    readonly contentLength?: number | undefined
  } | undefined
): Raw => new Raw(body, options?.contentType, options?.contentLength)

/**
 * @since 4.0.0
 * @category models
 */
export class Uint8Array extends Proto {
  readonly _tag = "Uint8Array"
  readonly body: globalThis.Uint8Array
  readonly contentType: string
  readonly contentLength: number

  constructor(
    body: globalThis.Uint8Array,
    contentType: string,
    contentLength: number
  ) {
    super()
    this.body = body
    this.contentType = contentType
    this.contentLength = contentLength
  }
  toJSON(): unknown {
    const toString = this.contentType.startsWith("text/") || this.contentType.endsWith("json")
    return {
      _id: "effect/HttpBody",
      _tag: "Uint8Array",
      body: toString ? new TextDecoder().decode(this.body) : `Uint8Array(${this.body.length})`,
      contentType: this.contentType,
      contentLength: this.contentLength
    }
  }
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const uint8Array = (body: globalThis.Uint8Array, contentType?: string): Uint8Array =>
  new Uint8Array(body, contentType ?? "application/octet-stream", body.length)

const encoder = new TextEncoder()

/**
 * @since 4.0.0
 * @category constructors
 */
export const text = (body: string, contentType?: string): Uint8Array =>
  uint8Array(encoder.encode(body), contentType ?? "text/plain")

/**
 * @since 4.0.0
 * @category constructors
 */
export const jsonUnsafe = (body: unknown, contentType?: string): Uint8Array =>
  text(JSON.stringify(body), contentType ?? "application/json")

/**
 * @since 4.0.0
 * @category constructors
 */
export const json = (body: unknown, contentType?: string): Effect.Effect<Uint8Array, HttpBodyError> =>
  Effect.try({
    try: () => text(JSON.stringify(body), contentType ?? "application/json"),
    catch: (cause) => new HttpBodyError({ reason: { _tag: "JsonError" }, cause })
  })

/**
 * @since 4.0.0
 * @category constructors
 */
export const jsonSchema = <S extends Schema.Top>(
  schema: S,
  options?: ParseOptions | undefined
) => {
  const encode = Parser.encodeUnknownEffect(Schema.toCodecJson(schema))
  return (body: S["Type"], contentType?: string): Effect.Effect<Uint8Array, HttpBodyError, S["EncodingServices"]> =>
    encode(body, options).pipe(
      Effect.mapError((issue) => new HttpBodyError({ reason: { _tag: "SchemaError", issue }, cause: issue })),
      Effect.flatMap((body) => json(body, contentType))
    )
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const urlParams = (urlParams: UrlParams.UrlParams, contentType?: string): Uint8Array =>
  text(UrlParams.toString(urlParams), contentType ?? "application/x-www-form-urlencoded")

/**
 * @since 4.0.0
 * @category models
 */
export class FormData extends Proto {
  readonly _tag = "FormData"
  readonly contentType = undefined
  readonly contentLength = undefined
  readonly formData: globalThis.FormData

  constructor(
    formData: globalThis.FormData
  ) {
    super()
    this.formData = formData
  }
  toJSON(): unknown {
    return {
      _id: "effect/HttpBody",
      _tag: "FormData",
      formData: this.formData
    }
  }
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const formData = (body: globalThis.FormData): FormData => new FormData(body)

/**
 * @since 4.0.0
 * @category models
 */
export type FormDataInput = Record<string, FormDataCoercible | ReadonlyArray<FormDataCoercible>>

/**
 * @since 4.0.0
 * @category models
 */
export type FormDataCoercible = string | number | boolean | globalThis.File | globalThis.Blob | null | undefined

const appendFormDataValue = (formData: globalThis.FormData, key: string, value: FormDataCoercible): void => {
  if (value == null) {
    return
  }
  if (typeof value === "object") {
    formData.append(key, value)
    return
  }
  formData.append(key, String(value))
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const formDataRecord = (entries: FormDataInput): FormData => {
  const data = new globalThis.FormData()
  for (const [key, value] of Object.entries(entries)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        appendFormDataValue(data, key, item)
      }
    } else {
      appendFormDataValue(data, key, value as FormDataCoercible)
    }
  }
  return formData(data)
}

/**
 * @since 4.0.0
 * @category models
 */
export class Stream extends Proto {
  readonly _tag = "Stream"
  readonly stream: Stream_.Stream<globalThis.Uint8Array, unknown>
  readonly contentType: string
  readonly contentLength: number | undefined

  constructor(
    stream: Stream_.Stream<globalThis.Uint8Array, unknown>,
    contentType: string,
    contentLength: number | undefined
  ) {
    super()
    this.stream = stream
    this.contentType = contentType
    this.contentLength = contentLength
  }
  toJSON(): unknown {
    return {
      _id: "effect/HttpBody",
      _tag: "Stream",
      contentType: this.contentType,
      contentLength: this.contentLength
    }
  }
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const stream = (
  body: Stream_.Stream<globalThis.Uint8Array, unknown>,
  contentType?: string,
  contentLength?: number
): Stream => new Stream(body, contentType ?? "application/octet-stream", contentLength)

/**
 * @since 4.0.0
 * @category constructors
 */
export const file = (
  path: string,
  options?: {
    readonly bytesToRead?: FileSystem.SizeInput | undefined
    readonly chunkSize?: FileSystem.SizeInput | undefined
    readonly offset?: FileSystem.SizeInput | undefined
    readonly contentType?: string | undefined
  }
): Effect.Effect<Stream, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.flatMap(
    FileSystem.FileSystem.asEffect(),
    (fs) =>
      Effect.map(fs.stat(path), (info) =>
        stream(
          fs.stream(path, options),
          options?.contentType,
          Number(info.size)
        ))
  )

/**
 * @since 4.0.0
 * @category constructors
 */
export const fileFromInfo = (
  path: string,
  info: FileSystem.File.Info,
  options?: {
    readonly bytesToRead?: FileSystem.SizeInput | undefined
    readonly chunkSize?: FileSystem.SizeInput | undefined
    readonly offset?: FileSystem.SizeInput | undefined
    readonly contentType?: string | undefined
  }
): Effect.Effect<Stream, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.map(
    FileSystem.FileSystem.asEffect(),
    (fs) =>
      stream(
        fs.stream(path, options),
        options?.contentType,
        Number(info.size)
      )
  )
