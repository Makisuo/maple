/**
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import type * as FileSystem from "../../FileSystem.ts"
import { dual } from "../../Function.ts"
import * as Inspectable from "../../Inspectable.ts"
import { stringOrRedacted } from "../../internal/redacted.ts"
import * as Option from "../../Option.ts"
import { type Pipeable, pipeArguments } from "../../Pipeable.ts"
import type * as PlatformError from "../../PlatformError.ts"
import { hasProperty } from "../../Predicate.ts"
import { redact } from "../../Redactable.ts"
import type * as Redacted from "../../Redacted.ts"
import * as Result from "../../Result.ts"
import type * as Schema from "../../Schema.ts"
import type { ParseOptions } from "../../SchemaAST.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import * as Stream from "../../Stream.ts"
import * as Headers from "./Headers.ts"
import * as HttpBody from "./HttpBody.ts"
import { hasBody, type HttpMethod } from "./HttpMethod.ts"
import * as UrlParams from "./UrlParams.ts"

const TypeId = "~effect/http/HttpClientRequest"

/**
 * @since 4.0.0
 * @category Guards
 */
export const isHttpClientRequest = (u: unknown): u is HttpClientRequest => hasProperty(u, TypeId)

/**
 * @since 4.0.0
 * @category models
 */
export interface HttpClientRequest extends Inspectable.Inspectable, Pipeable {
  readonly [TypeId]: typeof TypeId
  readonly method: HttpMethod
  readonly url: string
  readonly urlParams: UrlParams.UrlParams
  readonly hash: Option.Option<string>
  readonly headers: Headers.Headers
  readonly body: HttpBody.HttpBody
}

/**
 * @since 4.0.0
 * @category models
 */
export interface Options {
  readonly method?: HttpMethod | undefined
  readonly url?: string | URL | undefined
  readonly urlParams?: UrlParams.Input | undefined
  readonly hash?: string | undefined
  readonly headers?: Headers.Input | undefined
  readonly body?: HttpBody.HttpBody | undefined
  readonly accept?: string | undefined
  readonly acceptJson?: boolean | undefined
}

/**
 * @since 4.0.0
 */
export declare namespace Options {
  /**
   * @since 4.0.0
   * @category models
   */
  export interface NoUrl extends Omit<Options, "method" | "url"> {}
}

const Proto = {
  [TypeId]: TypeId,
  ...Inspectable.BaseProto,
  toJSON(this: HttpClientRequest): unknown {
    return {
      _id: "HttpClientRequest",
      method: this.method,
      url: this.url,
      urlParams: this.urlParams,
      hash: this.hash,
      headers: redact(this.headers),
      body: this.body.toJSON()
    }
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
}

/**
 * @since 4.0.0
 * @category constructors
 */
export function makeWith(
  method: HttpMethod,
  url: string,
  urlParams: UrlParams.UrlParams,
  hash: Option.Option<string>,
  headers: Headers.Headers,
  body: HttpBody.HttpBody
): HttpClientRequest {
  const self = Object.create(Proto)
  self.method = method
  self.url = url
  self.urlParams = urlParams
  self.hash = hash
  self.headers = headers
  self.body = body
  return self
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const empty: HttpClientRequest = makeWith(
  "GET",
  "",
  UrlParams.empty,
  Option.none(),
  Headers.empty,
  HttpBody.empty
)

/**
 * @since 4.0.0
 * @category constructors
 */
export const make = <M extends HttpMethod>(
  method: M
) =>
(
  url: string | URL,
  options?: Options.NoUrl | undefined
): HttpClientRequest =>
  modify(empty, {
    method,
    url,
    ...(options ?? undefined)
  })

/**
 * @since 4.0.0
 * @category constructors
 */
export const get: (url: string | URL, options?: Options.NoUrl) => HttpClientRequest = make("GET")

/**
 * @since 4.0.0
 * @category constructors
 */
export const post: (url: string | URL, options?: Options.NoUrl) => HttpClientRequest = make("POST")

/**
 * @since 4.0.0
 * @category constructors
 */
export const patch: (url: string | URL, options?: Options.NoUrl) => HttpClientRequest = make("PATCH")

/**
 * @since 4.0.0
 * @category constructors
 */
export const put: (url: string | URL, options?: Options.NoUrl) => HttpClientRequest = make("PUT")

const del: (url: string | URL, options?: Options.NoUrl) => HttpClientRequest = make("DELETE")

export {
  /**
   * @since 4.0.0
   * @category constructors
   */
  del as delete
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const head: (url: string | URL, options?: Options.NoUrl) => HttpClientRequest = make("HEAD")

/**
 * @since 4.0.0
 * @category constructors
 */
export const options: (url: string | URL, options?: Options.NoUrl) => HttpClientRequest = make("OPTIONS")

/**
 * @since 4.0.0
 * @category constructors
 */
export const trace: (url: string | URL, options?: Options.NoUrl) => HttpClientRequest = make("TRACE")

/**
 * @since 4.0.0
 * @category combinators
 */
export const modify: {
  (options: Options): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, options: Options): HttpClientRequest
} = dual(2, (self: HttpClientRequest, options: Options): HttpClientRequest => {
  let result = self

  if (options.method) {
    result = setMethod(result, options.method)
  }
  if (options.url) {
    result = setUrl(result, options.url)
  }
  if (options.headers) {
    result = setHeaders(result, options.headers)
  }
  if (options.urlParams) {
    result = setUrlParams(result, options.urlParams)
  }
  if (options.hash) {
    result = setHash(result, options.hash)
  }
  if (options.body) {
    result = setBody(result, options.body)
  }
  if (options.accept) {
    result = accept(result, options.accept)
  }
  if (options.acceptJson) {
    result = acceptJson(result)
  }

  return result
})

/**
 * @since 4.0.0
 * @category combinators
 */
export const setMethod: {
  (method: HttpMethod): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, method: HttpMethod): HttpClientRequest
} = dual(
  2,
  (self: HttpClientRequest, method: HttpMethod): HttpClientRequest =>
    makeWith(method, self.url, self.urlParams, self.hash, self.headers, self.body)
)

/**
 * @since 4.0.0
 * @category combinators
 */
export const setHeader: {
  (key: string, value: string): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, key: string, value: string): HttpClientRequest
} = dual(3, (self: HttpClientRequest, key: string, value: string): HttpClientRequest =>
  makeWith(
    self.method,
    self.url,
    self.urlParams,
    self.hash,
    Headers.set(self.headers, key, value),
    self.body
  ))

/**
 * @since 4.0.0
 * @category combinators
 */
export const setHeaders: {
  (input: Headers.Input): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, input: Headers.Input): HttpClientRequest
} = dual(2, (self: HttpClientRequest, input: Headers.Input): HttpClientRequest =>
  makeWith(
    self.method,
    self.url,
    self.urlParams,
    self.hash,
    Headers.setAll(self.headers, input),
    self.body
  ))

/**
 * @since 4.0.0
 * @category combinators
 */
export const basicAuth: {
  (
    username: string | Redacted.Redacted,
    password: string | Redacted.Redacted
  ): (self: HttpClientRequest) => HttpClientRequest
  (
    self: HttpClientRequest,
    username: string | Redacted.Redacted,
    password: string | Redacted.Redacted
  ): HttpClientRequest
} = dual(
  3,
  (
    self: HttpClientRequest,
    username: string | Redacted.Redacted,
    password: string | Redacted.Redacted
  ): HttpClientRequest =>
    setHeader(self, "Authorization", `Basic ${btoa(`${stringOrRedacted(username)}:${stringOrRedacted(password)}`)}`)
)

/**
 * @since 4.0.0
 * @category combinators
 */
export const bearerToken: {
  (token: string | Redacted.Redacted): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, token: string | Redacted.Redacted): HttpClientRequest
} = dual(
  2,
  (self: HttpClientRequest, token: string | Redacted.Redacted): HttpClientRequest =>
    setHeader(self, "Authorization", `Bearer ${stringOrRedacted(token)}`)
)

/**
 * @since 4.0.0
 * @category combinators
 */
export const accept: {
  (mediaType: string): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, mediaType: string): HttpClientRequest
} = dual(2, (self: HttpClientRequest, mediaType: string): HttpClientRequest => setHeader(self, "Accept", mediaType))

/**
 * @since 4.0.0
 * @category combinators
 */
export const acceptJson: (self: HttpClientRequest) => HttpClientRequest = accept("application/json")

/**
 * @since 4.0.0
 * @category combinators
 */
export const setUrl: {
  (url: string | URL): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, url: string | URL): HttpClientRequest
} = dual(2, (self: HttpClientRequest, url: string | URL): HttpClientRequest => {
  if (typeof url === "string") {
    return makeWith(
      self.method,
      url,
      self.urlParams,
      self.hash,
      self.headers,
      self.body
    )
  }
  const clone = new URL(url.toString())
  const urlParams = UrlParams.fromInput(clone.searchParams)
  const hash = Option.fromNullishOr(clone.hash === "" ? undefined : clone.hash.slice(1))
  clone.search = ""
  clone.hash = ""
  return makeWith(
    self.method,
    clone.toString(),
    urlParams,
    hash,
    self.headers,
    self.body
  )
})

/**
 * @since 4.0.0
 * @category combinators
 */
export const prependUrl: {
  (path: string): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, path: string): HttpClientRequest
} = dual(2, (self: HttpClientRequest, path: string): HttpClientRequest => {
  if (path === "") return self
  return makeWith(
    self.method,
    joinSegments(path, self.url),
    self.urlParams,
    self.hash,
    self.headers,
    self.body
  )
})

/**
 * @since 4.0.0
 * @category combinators
 */
export const appendUrl: {
  (path: string): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, path: string): HttpClientRequest
} = dual(2, (self: HttpClientRequest, path: string): HttpClientRequest => {
  if (path === "") return self
  return makeWith(
    self.method,
    joinSegments(self.url, path),
    self.urlParams,
    self.hash,
    self.headers,
    self.body
  )
})

const joinSegments = (first: string, second: string): string => {
  const endsWithSlash = first.endsWith("/")
  const startsWithSlash = second.startsWith("/")
  const needsTrim = endsWithSlash && startsWithSlash
  const needsSlash = !endsWithSlash && !startsWithSlash
  return needsTrim ?
    first + second.slice(1) :
    needsSlash ?
    first + "/" + second :
    first + second
}

/**
 * @since 4.0.0
 * @category combinators
 */
export const updateUrl: {
  (f: (url: string) => string): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, f: (url: string) => string): HttpClientRequest
} = dual(2, (self: HttpClientRequest, f: (url: string) => string): HttpClientRequest =>
  makeWith(
    self.method,
    f(self.url),
    self.urlParams,
    self.hash,
    self.headers,
    self.body
  ))

/**
 * @since 4.0.0
 * @category combinators
 */
export const setUrlParam: {
  (key: string, value: string): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, key: string, value: string): HttpClientRequest
} = dual(3, (self: HttpClientRequest, key: string, value: string): HttpClientRequest =>
  makeWith(
    self.method,
    self.url,
    UrlParams.set(self.urlParams, key, value),
    self.hash,
    self.headers,
    self.body
  ))

/**
 * @since 4.0.0
 * @category combinators
 */
export const setUrlParams: {
  (input: UrlParams.Input): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, input: UrlParams.Input): HttpClientRequest
} = dual(2, (self: HttpClientRequest, input: UrlParams.Input): HttpClientRequest =>
  makeWith(
    self.method,
    self.url,
    UrlParams.setAll(self.urlParams, input),
    self.hash,
    self.headers,
    self.body
  ))

/**
 * @since 4.0.0
 * @category combinators
 */
export const appendUrlParam: {
  (key: string, value: string): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, key: string, value: string): HttpClientRequest
} = dual(3, (self: HttpClientRequest, key: string, value: string): HttpClientRequest =>
  makeWith(
    self.method,
    self.url,
    UrlParams.append(self.urlParams, key, value),
    self.hash,
    self.headers,
    self.body
  ))

/**
 * @since 4.0.0
 * @category combinators
 */
export const appendUrlParams: {
  (input: UrlParams.Input): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, input: UrlParams.Input): HttpClientRequest
} = dual(2, (self: HttpClientRequest, input: UrlParams.Input): HttpClientRequest =>
  makeWith(
    self.method,
    self.url,
    UrlParams.appendAll(self.urlParams, input),
    self.hash,
    self.headers,
    self.body
  ))

/**
 * @since 4.0.0
 * @category combinators
 */
export const setHash: {
  (hash: string): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, hash: string): HttpClientRequest
} = dual(2, (self: HttpClientRequest, hash: string): HttpClientRequest =>
  makeWith(
    self.method,
    self.url,
    self.urlParams,
    Option.some(hash),
    self.headers,
    self.body
  ))

/**
 * @since 4.0.0
 * @category combinators
 */
export const removeHash = (self: HttpClientRequest): HttpClientRequest =>
  makeWith(
    self.method,
    self.url,
    self.urlParams,
    Option.none(),
    self.headers,
    self.body
  )

/**
 * @since 4.0.0
 * @category combinators
 */
export const setBody: {
  (body: HttpBody.HttpBody): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, body: HttpBody.HttpBody): HttpClientRequest
} = dual(2, (self: HttpClientRequest, body: HttpBody.HttpBody): HttpClientRequest => {
  let headers = self.headers
  if (body._tag === "Empty" || body._tag === "FormData") {
    headers = Headers.remove(Headers.remove(headers, "Content-Type"), "Content-length")
  } else {
    if (body.contentType) {
      headers = Headers.set(headers, "content-type", body.contentType)
    }
    if (body.contentLength !== undefined) {
      headers = Headers.set(headers, "content-length", body.contentLength.toString())
    }
  }
  return makeWith(
    self.method,
    self.url,
    self.urlParams,
    self.hash,
    headers,
    body
  )
})

/**
 * @since 4.0.0
 * @category combinators
 */
export const bodyUint8Array: {
  (body: Uint8Array, contentType?: string): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, body: Uint8Array, contentType?: string): HttpClientRequest
} = dual(
  (args) => isHttpClientRequest(args[0]),
  (self: HttpClientRequest, body: Uint8Array, contentType?: string): HttpClientRequest =>
    setBody(self, HttpBody.uint8Array(body, contentType))
)

/**
 * @since 4.0.0
 * @category combinators
 */
export const bodyText: {
  (body: string, contentType?: string): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, body: string, contentType?: string): HttpClientRequest
} = dual(
  (args) => isHttpClientRequest(args[0]),
  (self: HttpClientRequest, body: string, contentType?: string): HttpClientRequest =>
    setBody(self, HttpBody.text(body, contentType))
)

/**
 * @since 4.0.0
 * @category combinators
 */
export const bodyJson: {
  (body: unknown): (self: HttpClientRequest) => Effect.Effect<HttpClientRequest, HttpBody.HttpBodyError>
  (self: HttpClientRequest, body: unknown): Effect.Effect<HttpClientRequest, HttpBody.HttpBodyError>
} = dual(
  2,
  (self: HttpClientRequest, body: unknown): Effect.Effect<HttpClientRequest, HttpBody.HttpBodyError> =>
    Effect.map(HttpBody.json(body), (body) => setBody(self, body))
)

/**
 * @since 4.0.0
 * @category combinators
 */
export const bodyJsonUnsafe: {
  (body: unknown): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, body: unknown): HttpClientRequest
} = dual(2, (self: HttpClientRequest, body: unknown): HttpClientRequest => setBody(self, HttpBody.jsonUnsafe(body)))

/**
 * @since 4.0.0
 * @category combinators
 */
export const schemaBodyJson = <S extends Schema.Top>(
  schema: S,
  options?: ParseOptions | undefined
): {
  (
    body: S["Type"]
  ): (
    self: HttpClientRequest
  ) => Effect.Effect<HttpClientRequest, HttpBody.HttpBodyError, S["EncodingServices"]>
  (
    self: HttpClientRequest,
    body: S["Type"]
  ): Effect.Effect<HttpClientRequest, HttpBody.HttpBodyError, S["EncodingServices"]>
} => {
  const encode = HttpBody.jsonSchema(schema, options)
  return dual(
    2,
    (
      self: HttpClientRequest,
      body: unknown
    ): Effect.Effect<HttpClientRequest, HttpBody.HttpBodyError, S["EncodingServices"]> =>
      Effect.map(encode(body), (body) => setBody(self, body))
  )
}

/**
 * @since 4.0.0
 * @category combinators
 */
export const bodyUrlParams: {
  (input: UrlParams.Input): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, input: UrlParams.Input): HttpClientRequest
} = dual(
  2,
  (self: HttpClientRequest, input: UrlParams.Input): HttpClientRequest =>
    setBody(self, HttpBody.urlParams(UrlParams.fromInput(input)))
)

/**
 * @since 4.0.0
 * @category combinators
 */
export const bodyFormData: {
  (body: FormData): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, body: FormData): HttpClientRequest
} = dual(2, (self: HttpClientRequest, body: FormData): HttpClientRequest => setBody(self, HttpBody.formData(body)))

/**
 * @since 4.0.0
 * @category combinators
 */
export const bodyFormDataRecord: {
  (entries: HttpBody.FormDataInput): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, entries: HttpBody.FormDataInput): HttpClientRequest
} = dual(
  2,
  (self: HttpClientRequest, entries: HttpBody.FormDataInput): HttpClientRequest =>
    setBody(self, HttpBody.formDataRecord(entries))
)

/**
 * @since 4.0.0
 * @category combinators
 */
export const bodyStream: {
  (
    body: Stream.Stream<Uint8Array, unknown>,
    options?: { readonly contentType?: string | undefined; readonly contentLength?: number | undefined } | undefined
  ): (self: HttpClientRequest) => HttpClientRequest
  (
    self: HttpClientRequest,
    body: Stream.Stream<Uint8Array, unknown>,
    options?: { readonly contentType?: string | undefined; readonly contentLength?: number | undefined } | undefined
  ): HttpClientRequest
} = dual(
  (args) => isHttpClientRequest(args[0]),
  (
    self: HttpClientRequest,
    body: Stream.Stream<Uint8Array, unknown>,
    options?: { readonly contentType?: string | undefined; readonly contentLength?: number | undefined } | undefined
  ): HttpClientRequest =>
    setBody(
      self,
      HttpBody.stream(body, options?.contentType, options?.contentLength)
    )
)

/**
 * @since 4.0.0
 * @category combinators
 */
export const bodyFile: {
  (
    path: string,
    options?: {
      readonly bytesToRead?: FileSystem.SizeInput | undefined
      readonly chunkSize?: FileSystem.SizeInput | undefined
      readonly offset?: FileSystem.SizeInput | undefined
      readonly contentType?: string
    }
  ): (self: HttpClientRequest) => Effect.Effect<HttpClientRequest, PlatformError.PlatformError, FileSystem.FileSystem>
  (
    self: HttpClientRequest,
    path: string,
    options?: {
      readonly bytesToRead?: FileSystem.SizeInput | undefined
      readonly chunkSize?: FileSystem.SizeInput | undefined
      readonly offset?: FileSystem.SizeInput | undefined
      readonly contentType?: string
    }
  ): Effect.Effect<HttpClientRequest, PlatformError.PlatformError, FileSystem.FileSystem>
} = dual(
  (args) => isHttpClientRequest(args[0]),
  (
    self: HttpClientRequest,
    path: string,
    options?: {
      readonly bytesToRead?: FileSystem.SizeInput | undefined
      readonly chunkSize?: FileSystem.SizeInput | undefined
      readonly offset?: FileSystem.SizeInput | undefined
      readonly contentType?: string
    }
  ): Effect.Effect<HttpClientRequest, PlatformError.PlatformError, FileSystem.FileSystem> =>
    Effect.map(
      HttpBody.file(path, options),
      (body) => setBody(self, body)
    )
)

/**
 * @since 4.0.0
 * @category combinators
 */
export function toUrl(self: HttpClientRequest): Option.Option<URL> {
  const r = UrlParams.makeUrl(self.url, self.urlParams, Option.getOrUndefined(self.hash))
  if (Result.isSuccess(r)) {
    return Option.some(r.success)
  }
  return Option.none()
}

/**
 * @since 4.0.0
 * @category conversions
 */
export const fromWeb = (request: globalThis.Request): HttpClientRequest => {
  const method = request.method.toUpperCase() as HttpMethod
  return modify(empty, {
    method,
    url: new URL(request.url),
    headers: request.headers,
    body: fromWebBody(request, method)
  })
}

const fromWebBody = (request: globalThis.Request, method: HttpMethod): HttpBody.HttpBody => {
  if (!hasBody(method) || request.body === null) {
    return HttpBody.empty
  }
  return HttpBody.raw(request.body, {
    contentType: request.headers.get("content-type") ?? undefined,
    contentLength: parseContentLength(request.headers.get("content-length"))
  })
}

const parseContentLength = (contentLength: string | null): number | undefined => {
  if (contentLength === null) {
    return undefined
  }
  const parsed = Number.parseInt(contentLength, 10)
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * @since 4.0.0
 * @category conversions
 */
export const toWebResult = (self: HttpClientRequest, options?: {
  readonly signal?: AbortSignal | undefined
  readonly services?: ServiceMap.ServiceMap<never> | undefined
}): Result.Result<Request, UrlParams.UrlParamsError> => {
  const url = UrlParams.makeUrl(self.url, self.urlParams, Option.getOrUndefined(self.hash))
  if (Result.isFailure(url)) {
    return Result.fail(url.failure)
  }
  const requestInit: RequestInit = {
    method: self.method,
    headers: self.headers
  }
  if (options?.signal) {
    requestInit.signal = options.signal
  }
  if (hasBody(self.method)) {
    switch (self.body._tag) {
      case "Empty": {
        break
      }
      case "Raw": {
        requestInit.body = self.body.body as any
        if (isReadableStream(self.body.body)) {
          ;(requestInit as any).duplex = "half"
        }
        break
      }
      case "Uint8Array": {
        requestInit.body = self.body.body as any
        break
      }
      case "FormData": {
        requestInit.body = self.body.formData
        break
      }
      case "Stream": {
        requestInit.body = Stream.toReadableStreamWith(self.body.stream, options?.services ?? ServiceMap.empty())
        ;(requestInit as any).duplex = "half"
        break
      }
    }
  }
  return Result.try({
    try: () => new Request(url.success, requestInit),
    catch: (cause) => new UrlParams.UrlParamsError({ cause })
  })
}

const isReadableStream = (u: unknown): u is ReadableStream<Uint8Array> =>
  typeof ReadableStream !== "undefined" && u instanceof ReadableStream

/**
 * @since 4.0.0
 * @category conversions
 */
export const toWeb = (self: HttpClientRequest, options?: {
  readonly signal?: AbortSignal | undefined
}): Effect.Effect<Request, UrlParams.UrlParamsError> =>
  Effect.servicesWith((services) =>
    toWebResult(self, {
      services,
      signal: options?.signal
    }).asEffect()
  )
