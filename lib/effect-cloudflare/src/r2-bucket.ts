// Simplified port of alchemy-effect's R2 bucket binding:
//   https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/Cloudflare/R2/R2BucketBinding.ts
//
// As with KV, we drop the resource half (bucket provisioning via the CF
// Account API) and keep the runtime half. `R2Bucket("MY_BUCKET")` is a
// lightweight token; `R2Bucket.bind(token)` yields the client.
import type * as runtime from "@cloudflare/workers-types"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { WorkerEnvironment } from "./worker-environment.ts"

export class R2Error extends Data.TaggedError("R2Error")<{
  message: string
  cause: unknown
}> {}

export interface R2BucketToken {
  readonly Type: "Cloudflare.R2Bucket"
  readonly LogicalId: string
}

const makeToken = (logicalId: string): R2BucketToken => ({
  Type: "Cloudflare.R2Bucket",
  LogicalId: logicalId,
})

export interface R2Object extends Omit<runtime.R2Object, "writeHttpMetadata"> {
  writeHttpMetadata(headers: Headers): Effect.Effect<void>
}

export interface R2ObjectBody extends R2Object {
  get body(): Stream.Stream<Uint8Array, R2Error>
  get bodyUsed(): boolean
  arrayBuffer(): Effect.Effect<ArrayBuffer, R2Error>
  bytes(): Effect.Effect<Uint8Array, R2Error>
  text(): Effect.Effect<string, R2Error>
  json<T>(): Effect.Effect<T, R2Error>
  blob(): Effect.Effect<runtime.Blob, R2Error>
}

export type R2GetOptions = runtime.R2GetOptions
export type R2PutOptions = runtime.R2PutOptions & {
  contentLength?: number
}
export type R2ListOptions = runtime.R2ListOptions
export type R2Objects = {
  objects: R2Object[]
  delimitedPrefixes: string[]
} & (
  | {
      truncated: true
      cursor: string
    }
  | {
      truncated: false
    }
)

export interface R2MultipartUpload {
  raw: runtime.R2MultipartUpload
  readonly key: string
  readonly uploadId: string
  uploadPart(
    partNumber: number,
    value:
      | ReadableStream
      | ArrayBuffer
      | ArrayBufferView
      | string
      | runtime.Blob,
    options?: runtime.R2UploadPartOptions,
  ): Effect.Effect<runtime.R2UploadedPart, R2Error>
  abort(): Effect.Effect<void, R2Error>
  complete(
    uploadedParts: runtime.R2UploadedPart[],
  ): Effect.Effect<R2Object, R2Error>
}

export interface R2BucketClient {
  raw: Effect.Effect<runtime.R2Bucket, never, WorkerEnvironment>
  head(
    key: string,
  ): Effect.Effect<R2Object | null, R2Error, WorkerEnvironment>
  get(
    key: string,
    options?: R2GetOptions,
  ): Effect.Effect<R2ObjectBody | null, R2Error, WorkerEnvironment>
  put(
    key: string,
    value:
      | ReadableStream
      | ArrayBuffer
      | ArrayBufferView
      | string
      | null
      | runtime.Blob,
    options?: R2PutOptions,
  ): Effect.Effect<R2Object, R2Error, WorkerEnvironment>
  delete(
    keys: string | string[],
  ): Effect.Effect<void, R2Error, WorkerEnvironment>
  list(
    options?: R2ListOptions,
  ): Effect.Effect<R2Objects, R2Error, WorkerEnvironment>
  createMultipartUpload(
    key: string,
    options?: runtime.R2MultipartOptions,
  ): Effect.Effect<R2MultipartUpload, R2Error, WorkerEnvironment>
  resumeMultipartUpload(
    key: string,
    uploadId: string,
  ): Effect.Effect<R2MultipartUpload, R2Error, WorkerEnvironment>
}

const makeClient = (token: R2BucketToken): R2BucketClient => {
  const env = WorkerEnvironment.asEffect()
  const raw = env.pipe(
    Effect.map(
      (e) => (e as Record<string, runtime.R2Bucket>)[token.LogicalId],
    ),
  )

  const tryPromise = <T>(fn: () => Promise<T>): Effect.Effect<T, R2Error> =>
    Effect.tryPromise({
      try: fn,
      catch: (cause) =>
        new R2Error({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    })

  const use = <T>(
    fn: (raw: runtime.R2Bucket) => Promise<T>,
  ): Effect.Effect<T, R2Error, WorkerEnvironment> =>
    raw.pipe(Effect.flatMap((r) => tryPromise(() => fn(r))))

  const wrapR2Object = (object: runtime.R2Object): R2Object => ({
    ...object,
    writeHttpMetadata: (headers: Headers) =>
      Effect.sync(() => object.writeHttpMetadata(headers as unknown as runtime.Headers)),
  })

  const wrapR2ObjectBody = (object: runtime.R2ObjectBody): R2ObjectBody => ({
    ...wrapR2Object(object),
    body: Stream.fromReadableStream({
      evaluate: () => object.body as unknown as ReadableStream<Uint8Array>,
      onError: (cause) =>
        new R2Error({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }),
    bodyUsed: object.bodyUsed,
    arrayBuffer: () => tryPromise(() => object.arrayBuffer()),
    bytes: () => tryPromise(() => object.bytes()),
    text: () => tryPromise(() => object.text()),
    json: <T>() => tryPromise(() => object.json<T>()),
    blob: () => tryPromise(() => object.blob()),
  })

  const wrapR2Objects = (objects: runtime.R2Objects): R2Objects =>
    ({
      objects: objects.objects.map(wrapR2Object),
      delimitedPrefixes: objects.delimitedPrefixes,
      ...("cursor" in objects ? { cursor: objects.cursor } : {}),
      ...("truncated" in objects ? { truncated: objects.truncated } : {}),
    }) as R2Objects

  const wrapR2MultipartUpload = (
    upload: runtime.R2MultipartUpload,
  ): R2MultipartUpload => ({
    ...upload,
    raw: upload,
    uploadId: upload.uploadId,
    abort: () => tryPromise(() => upload.abort()),
    complete: (uploadedParts: runtime.R2UploadedPart[]) =>
      tryPromise(() => upload.complete(uploadedParts)).pipe(
        Effect.map(wrapR2Object),
      ),
    uploadPart: (
      partNumber: number,
      value:
        | ReadableStream
        | ArrayBuffer
        | ArrayBufferView
        | string
        | runtime.Blob,
      options?: runtime.R2UploadPartOptions,
    ) =>
      tryPromise(() => upload.uploadPart(partNumber, value as any, options)),
  })

  return {
    raw,
    head: (key: string) =>
      use((r) => r.head(key)).pipe(
        Effect.map((object) => (object ? wrapR2Object(object) : object)),
      ),
    get: (key: string, options?: R2GetOptions) =>
      use((r) => r.get(key, options)).pipe(
        Effect.map((object) =>
          object === null ? null : wrapR2ObjectBody(object as runtime.R2ObjectBody),
        ),
      ),
    put: (
      key: string,
      value:
        | ReadableStream
        | ArrayBuffer
        | ArrayBufferView
        | string
        | null
        | runtime.Blob,
      options?: R2PutOptions,
    ) =>
      use((r) => r.put(key, value as any, options)).pipe(
        Effect.map((object) =>
          object === null
            ? (null as unknown as R2Object)
            : wrapR2Object(object as runtime.R2Object),
        ),
      ) as Effect.Effect<R2Object, R2Error, WorkerEnvironment>,
    delete: (keys: string | string[]) => use((r) => r.delete(keys)),
    list: (options?: R2ListOptions) =>
      use((r) => r.list(options)).pipe(Effect.map(wrapR2Objects)),
    createMultipartUpload: (
      key: string,
      options?: runtime.R2MultipartOptions,
    ) =>
      use((r) => r.createMultipartUpload(key, options)).pipe(
        Effect.map(wrapR2MultipartUpload),
      ),
    resumeMultipartUpload: (key: string, uploadId: string) =>
      raw.pipe(
        Effect.map((r) => r.resumeMultipartUpload(key, uploadId)),
        Effect.map(wrapR2MultipartUpload),
      ),
  } satisfies R2BucketClient as R2BucketClient
}

export const R2Bucket = Object.assign(
  (logicalId: string): R2BucketToken => makeToken(logicalId),
  {
    bind: (
      token: R2BucketToken,
    ): Effect.Effect<R2BucketClient, never, never> =>
      Effect.succeed(makeClient(token)),
  },
)
