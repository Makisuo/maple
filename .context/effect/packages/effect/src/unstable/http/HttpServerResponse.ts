/**
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import * as ErrorReporter from "../../ErrorReporter.ts"
import type * as FileSystem from "../../FileSystem.ts"
import { dual } from "../../Function.ts"
import * as Inspectable from "../../Inspectable.ts"
import { PipeInspectableProto } from "../../internal/core.ts"
import * as Option from "../../Option.ts"
import { type Pipeable, pipeArguments } from "../../Pipeable.ts"
import type { PlatformError } from "../../PlatformError.ts"
import { hasProperty } from "../../Predicate.ts"
import { redact } from "../../Redactable.ts"
import type * as Schema from "../../Schema.ts"
import type { ParseOptions } from "../../SchemaAST.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import * as Stream from "../../Stream.ts"
import type { Mutable } from "../../Types.ts"
import * as Cookies from "./Cookies.ts"
import * as Headers from "./Headers.ts"
import * as Body from "./HttpBody.ts"
import * as HttpClientError from "./HttpClientError.ts"
import * as HttpClientRequest from "./HttpClientRequest.ts"
import * as HttpClientResponse from "./HttpClientResponse.ts"
import * as HttpIncomingMessage from "./HttpIncomingMessage.ts"
import type { HttpPlatform } from "./HttpPlatform.ts"
import * as Template from "./Template.ts"
import * as UrlParams from "./UrlParams.ts"

const TypeId = "~effect/http/HttpServerResponse"

/**
 * @since 4.0.0
 * @category models
 */
export interface HttpServerResponse extends Inspectable.Inspectable, Pipeable, ErrorReporter.Reportable {
  readonly [TypeId]: typeof TypeId
  readonly status: number
  readonly statusText?: string | undefined
  readonly headers: Headers.Headers
  readonly cookies: Cookies.Cookies
  readonly body: Body.HttpBody
}

/**
 * @since 4.0.0
 * @category models
 */
export interface Options {
  readonly status?: number | undefined
  readonly statusText?: string | undefined
  readonly headers?: Headers.Input | undefined
  readonly cookies?: Cookies.Cookies | undefined
  readonly contentType?: string | undefined
  readonly contentLength?: number | undefined
}

/**
 * @since 4.0.0
 */
export declare namespace Options {
  /**
   * @since 4.0.0
   * @category models
   */
  export interface WithContent extends Omit<Options, "contentType" | "contentLength"> {}

  /**
   * @since 4.0.0
   * @category models
   */
  export interface WithContentType extends Omit<Options, "contentLength"> {}
}

/**
 * @since 4.0.0
 */
export const isHttpServerResponse = (u: unknown): u is HttpServerResponse => hasProperty(u, TypeId)

/**
 * @since 4.0.0
 * @category constructors
 */
export const empty = (
  options?: Options.WithContent | undefined
): HttpServerResponse =>
  makeResponse({
    status: options?.status ?? 204,
    statusText: options?.statusText,
    headers: options?.headers ? Headers.fromInput(options.headers) : undefined,
    cookies: options?.cookies
  })

/**
 * @since 4.0.0
 * @category constructors
 */
export const redirect = (
  location: string | URL,
  options?: Options.WithContent | undefined
): HttpServerResponse => {
  const headers = Headers.fromRecordUnsafe({ location: location.toString() })
  return makeResponse({
    status: options?.status ?? 302,
    statusText: options?.statusText,
    headers: options?.headers
      ? Headers.merge(headers, Headers.fromInput(options.headers))
      : headers,
    cookies: options?.cookies ?? Cookies.empty
  })
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const uint8Array = (
  body: Uint8Array,
  options?: Options.WithContentType
): HttpServerResponse => {
  const headers = options?.headers
    ? Headers.fromInput(options.headers)
    : Headers.empty
  return makeResponse({
    status: options?.status ?? 200,
    statusText: options?.statusText,
    headers,
    cookies: options?.cookies ?? Cookies.empty,
    body: Body.uint8Array(body, getContentType(options, headers))
  })
}

const getContentType = (
  options: Options | undefined,
  headers: Headers.Headers
): string | undefined => {
  if (options?.contentType) {
    return options.contentType
  } else if (options?.headers) {
    return headers["content-type"]
  }
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const text = (
  body: string,
  options?: Options.WithContentType
): HttpServerResponse => {
  const headers = options?.headers
    ? Headers.fromInput(options.headers)
    : Headers.empty
  return makeResponse({
    status: options?.status ?? 200,
    statusText: options?.statusText,
    headers,
    cookies: options?.cookies ?? Cookies.empty,
    body: Body.text(body, getContentType(options, headers))
  })
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const html: {
  <A extends ReadonlyArray<Template.Interpolated>>(
    strings: TemplateStringsArray,
    ...args: A
  ): Effect.Effect<
    HttpServerResponse,
    Template.Interpolated.Error<A[number]>,
    Template.Interpolated.Context<A[number]>
  >
  (html: string): HttpServerResponse
} = (
  strings: TemplateStringsArray | string,
  ...args: ReadonlyArray<Template.Interpolated>
) => {
  if (typeof strings === "string") {
    return text(strings, { contentType: "text/html" })
  }

  return Effect.map(Template.make(strings, ...args), (_) => text(_, { contentType: "text/html" })) as any
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const htmlStream = <
  A extends ReadonlyArray<Template.InterpolatedWithStream>
>(
  strings: TemplateStringsArray,
  ...args: A
): Effect.Effect<
  HttpServerResponse,
  never,
  Template.Interpolated.Context<A[number]>
> =>
  Effect.map(
    Effect.services<Template.Interpolated.Context<A[number]>>(),
    (context) =>
      stream(
        Stream.provideServices(
          Stream.encodeText(Template.stream(strings, ...args)),
          context
        ),
        { contentType: "text/html" }
      )
  )

/**
 * @since 4.0.0
 * @category constructors
 */
export const json = (
  body: unknown,
  options?: Options.WithContentType | undefined
): Effect.Effect<HttpServerResponse, Body.HttpBodyError> => {
  const headers = options?.headers ? Headers.fromInput(options.headers) : Headers.empty
  return Effect.map(Body.json(body, getContentType(options, headers)), (body) =>
    makeResponse({
      status: options?.status ?? 200,
      statusText: options?.statusText,
      headers,
      cookies: options?.cookies,
      body
    }))
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const schemaJson = <A, I, RD, RE>(
  schema: Schema.Codec<A, I, RD, RE>,
  options?: ParseOptions | undefined
) => {
  const encode = Body.jsonSchema(schema, options)
  return (
    body: A,
    options?: Options.WithContentType | undefined
  ): Effect.Effect<HttpServerResponse, Body.HttpBodyError, RE> => {
    const headers = options?.headers ? Headers.fromInput(options.headers) : Headers.empty
    return Effect.map(encode(body, getContentType(options, headers)), (body) =>
      makeResponse({
        status: options?.status ?? 200,
        statusText: options?.statusText,
        headers,
        cookies: options?.cookies,
        body
      }))
  }
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const jsonUnsafe = (
  body: unknown,
  options?: Options.WithContentType | undefined
): HttpServerResponse => {
  const headers = options?.headers ? Headers.fromInput(options.headers) : Headers.empty
  return makeResponse({
    status: options?.status ?? 200,
    statusText: options?.statusText,
    headers,
    cookies: options?.cookies,
    body: Body.jsonUnsafe(body, getContentType(options, headers))
  })
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const urlParams = (
  body: UrlParams.Input,
  options?: Options.WithContentType | undefined
): HttpServerResponse => {
  const headers = options?.headers ? Headers.fromInput(options.headers) : Headers.empty
  return makeResponse({
    status: options?.status ?? 200,
    statusText: options?.statusText,
    headers,
    cookies: options?.cookies,
    body: Body.text(
      UrlParams.toString(UrlParams.fromInput(body)),
      getContentType(options, headers) ?? "application/x-www-form-urlencoded"
    )
  })
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const raw = (
  body: unknown,
  options?: Options | undefined
): HttpServerResponse =>
  makeResponse({
    status: options?.status ?? 200,
    statusText: options?.statusText,
    headers: options?.headers && Headers.fromInput(options.headers),
    cookies: options?.cookies,
    body: Body.raw(body, {
      contentType: options?.contentType,
      contentLength: options?.contentLength
    })
  })

/**
 * @since 4.0.0
 * @category constructors
 */
export const formData = (
  body: FormData,
  options?: Options.WithContent | undefined
): HttpServerResponse =>
  makeResponse({
    status: options?.status ?? 200,
    statusText: options?.statusText,
    headers: options?.headers && Headers.fromInput(options.headers),
    cookies: options?.cookies,
    body: Body.formData(body)
  })

/**
 * @since 4.0.0
 * @category constructors
 */
export const stream = <E>(
  body: Stream.Stream<Uint8Array, E>,
  options?: Options | undefined
): HttpServerResponse => {
  const headers = options?.headers
    ? Headers.fromInput(options.headers)
    : Headers.empty
  return makeResponse({
    status: options?.status ?? 200,
    statusText: options?.statusText,
    headers,
    cookies: options?.cookies,
    body: Body.stream(
      body,
      getContentType(options, headers),
      options?.contentLength
    )
  })
}

const HttpPlatformKey = ServiceMap.Service<
  HttpPlatform,
  HttpPlatform["Service"]
>("effect/http/HttpPlatform" satisfies typeof HttpPlatform.key)

/**
 * @since 4.0.0
 * @category constructors
 */
export const file = (
  path: string,
  options?:
    | (Options & {
      readonly bytesToRead?: FileSystem.SizeInput | undefined
      readonly chunkSize?: FileSystem.SizeInput | undefined
      readonly offset?: FileSystem.SizeInput | undefined
    })
    | undefined
): Effect.Effect<HttpServerResponse, PlatformError, HttpPlatform> =>
  Effect.flatMap(HttpPlatformKey.asEffect(), (platform) => platform.fileResponse(path, options))

/**
 * @since 4.0.0
 * @category constructors
 */
export const fileWeb = (
  file: Body.HttpBody.FileLike,
  options?:
    | (Options.WithContent & {
      readonly bytesToRead?: FileSystem.SizeInput | undefined
      readonly chunkSize?: FileSystem.SizeInput | undefined
      readonly offset?: FileSystem.SizeInput | undefined
    })
    | undefined
): Effect.Effect<HttpServerResponse, never, HttpPlatform> =>
  Effect.flatMap(HttpPlatformKey.asEffect(), (platform) => platform.fileWebResponse(file, options))

/**
 * @since 4.0.0
 * @category combinators
 */
export const setHeader: {
  (
    key: string,
    value: string
  ): (self: HttpServerResponse) => HttpServerResponse
  (self: HttpServerResponse, key: string, value: string): HttpServerResponse
} = dual(
  3,
  (self: HttpServerResponse, key: string, value: string): HttpServerResponse =>
    makeResponse({
      ...self,
      headers: Headers.set(self.headers, key, value)
    })
)

/**
 * @since 4.0.0
 * @category combinators
 */
export const setHeaders: {
  (input: Headers.Input): (self: HttpServerResponse) => HttpServerResponse
  (self: HttpServerResponse, input: Headers.Input): HttpServerResponse
} = dual(
  2,
  (self: HttpServerResponse, input: Headers.Input): HttpServerResponse =>
    makeResponse({
      ...self,
      headers: Headers.setAll(self.headers, input)
    })
)

/**
 * @since 4.0.0
 * @category combinators
 */
export const removeCookie: {
  (name: string): (self: HttpServerResponse) => HttpServerResponse
  (self: HttpServerResponse, name: string): HttpServerResponse
} = dual(
  2,
  (self: HttpServerResponse, name: string): HttpServerResponse =>
    makeResponse({
      ...self,
      cookies: Cookies.remove(self.cookies, name)
    })
)

/**
 * @since 4.0.0
 * @category combinators
 */
export const replaceCookies: {
  (cookies: Cookies.Cookies): (self: HttpServerResponse) => HttpServerResponse
  (self: HttpServerResponse, cookies: Cookies.Cookies): HttpServerResponse
} = dual(
  2,
  (self: HttpServerResponse, cookies: Cookies.Cookies): HttpServerResponse => makeResponse({ ...self, cookies })
)

/**
 * @since 4.0.0
 * @category combinators
 */
export const setCookie: {
  (
    name: string,
    value: string,
    options?: Cookies.Cookie["options"]
  ): (
    self: HttpServerResponse
  ) => Effect.Effect<HttpServerResponse, Cookies.CookiesError>
  (
    self: HttpServerResponse,
    name: string,
    value: string,
    options?: Cookies.Cookie["options"]
  ): Effect.Effect<HttpServerResponse, Cookies.CookiesError>
} = dual(
  (args) => isHttpServerResponse(args[0]),
  (
    self: HttpServerResponse,
    name: string,
    value: string,
    options?: Cookies.Cookie["options"]
  ): Effect.Effect<HttpServerResponse, Cookies.CookiesError> =>
    Effect.map(
      Cookies.set(self.cookies, name, value, options).asEffect(),
      (cookies) =>
        makeResponse({
          ...self,
          cookies
        })
    )
)

/**
 * @since 4.0.0
 * @category combinators
 */
export const expireCookie: {
  (
    name: string,
    options?: Omit<NonNullable<Cookies.Cookie["options"]>, "expires" | "maxAge">
  ): (
    self: HttpServerResponse
  ) => Effect.Effect<HttpServerResponse, Cookies.CookiesError>
  (
    self: HttpServerResponse,
    name: string,
    options?: Omit<NonNullable<Cookies.Cookie["options"]>, "expires" | "maxAge">
  ): Effect.Effect<HttpServerResponse, Cookies.CookiesError>
} = dual(
  (args) => isHttpServerResponse(args[0]),
  (
    self: HttpServerResponse,
    name: string,
    options?: Omit<NonNullable<Cookies.Cookie["options"]>, "expires" | "maxAge">
  ): Effect.Effect<HttpServerResponse, Cookies.CookiesError> =>
    Effect.map(
      Cookies.expireCookie(self.cookies, name, options).asEffect(),
      (cookies) =>
        makeResponse({
          ...self,
          cookies
        })
    )
)

/**
 * @since 4.0.0
 * @category combinators
 */
export const setCookieUnsafe: {
  (
    name: string,
    value: string,
    options?: Cookies.Cookie["options"]
  ): (self: HttpServerResponse) => HttpServerResponse
  (
    self: HttpServerResponse,
    name: string,
    value: string,
    options?: Cookies.Cookie["options"]
  ): HttpServerResponse
} = dual(
  (args) => isHttpServerResponse(args[0]),
  (
    self: HttpServerResponse,
    name: string,
    value: string,
    options?: Cookies.Cookie["options"]
  ): HttpServerResponse =>
    makeResponse({
      ...self,
      cookies: Cookies.setUnsafe(self.cookies, name, value, options)
    })
)

/**
 * @since 4.0.0
 * @category combinators
 */
export const expireCookieUnsafe: {
  (
    name: string,
    options?: Omit<NonNullable<Cookies.Cookie["options"]>, "expires" | "maxAge">
  ): (self: HttpServerResponse) => HttpServerResponse
  (
    self: HttpServerResponse,
    name: string,
    options?: Omit<NonNullable<Cookies.Cookie["options"]>, "expires" | "maxAge">
  ): HttpServerResponse
} = dual(
  (args) => isHttpServerResponse(args[0]),
  (
    self: HttpServerResponse,
    name: string,
    options?: Omit<NonNullable<Cookies.Cookie["options"]>, "expires" | "maxAge">
  ): HttpServerResponse =>
    makeResponse({
      ...self,
      cookies: Cookies.expireCookieUnsafe(self.cookies, name, options)
    })
)

/**
 * @since 4.0.0
 * @category combinators
 */
export const updateCookies: {
  (
    f: (cookies: Cookies.Cookies) => Cookies.Cookies
  ): (self: HttpServerResponse) => HttpServerResponse
  (
    self: HttpServerResponse,
    f: (cookies: Cookies.Cookies) => Cookies.Cookies
  ): HttpServerResponse
} = dual(
  2,
  (
    self: HttpServerResponse,
    f: (cookies: Cookies.Cookies) => Cookies.Cookies
  ): HttpServerResponse =>
    makeResponse({
      ...self,
      cookies: f(self.cookies)
    })
)

/**
 * @since 4.0.0
 * @category combinators
 */
export const mergeCookies: {
  (cookies: Cookies.Cookies): (self: HttpServerResponse) => HttpServerResponse
  (self: HttpServerResponse, cookies: Cookies.Cookies): HttpServerResponse
} = dual(
  2,
  (self: HttpServerResponse, cookies: Cookies.Cookies): HttpServerResponse =>
    makeResponse({ ...self, cookies: Cookies.merge(self.cookies, cookies) })
)

/**
 * @since 4.0.0
 * @category combinators
 */
export const setCookies: {
  (
    cookies: Iterable<
      readonly [
        name: string,
        value: string,
        options?: Cookies.Cookie["options"]
      ]
    >
  ): (
    self: HttpServerResponse
  ) => Effect.Effect<HttpServerResponse, Cookies.CookiesError, never>
  (
    self: HttpServerResponse,
    cookies: Iterable<
      readonly [
        name: string,
        value: string,
        options?: Cookies.Cookie["options"]
      ]
    >
  ): Effect.Effect<HttpServerResponse, Cookies.CookiesError, never>
} = dual(
  2,
  (
    self: HttpServerResponse,
    cookies: Iterable<
      readonly [
        name: string,
        value: string,
        options?: Cookies.Cookie["options"]
      ]
    >
  ): Effect.Effect<HttpServerResponse, Cookies.CookiesError> =>
    Effect.map(Cookies.setAll(self.cookies, cookies).asEffect(), (cookies) =>
      makeResponse({
        ...self,
        cookies
      }))
)

/**
 * @since 4.0.0
 * @category combinators
 */
export const setCookiesUnsafe: {
  (
    cookies: Iterable<
      readonly [
        name: string,
        value: string,
        options?: Cookies.Cookie["options"]
      ]
    >
  ): (self: HttpServerResponse) => HttpServerResponse
  (
    self: HttpServerResponse,
    cookies: Iterable<
      readonly [
        name: string,
        value: string,
        options?: Cookies.Cookie["options"]
      ]
    >
  ): HttpServerResponse
} = dual(
  2,
  (
    self: HttpServerResponse,
    cookies: Iterable<
      readonly [
        name: string,
        value: string,
        options?: Cookies.Cookie["options"]
      ]
    >
  ): HttpServerResponse =>
    makeResponse({
      ...self,
      cookies: Cookies.setAllUnsafe(self.cookies, cookies)
    })
)

/**
 * @since 4.0.0
 * @category combinators
 */
export const setBody: {
  (body: Body.HttpBody): (self: HttpServerResponse) => HttpServerResponse
  (self: HttpServerResponse, body: Body.HttpBody): HttpServerResponse
} = dual(
  2,
  (self: HttpServerResponse, body: Body.HttpBody): HttpServerResponse => makeResponse({ ...self, body })
)

/**
 * @since 4.0.0
 * @category combinators
 */
export const setStatus: {
  (
    status: number,
    statusText?: string | undefined
  ): (self: HttpServerResponse) => HttpServerResponse
  (
    self: HttpServerResponse,
    status: number,
    statusText?: string | undefined
  ): HttpServerResponse
} = dual(
  (args) => isHttpServerResponse(args[0]),
  (
    self: HttpServerResponse,
    status: number,
    statusText?: string | undefined
  ): HttpServerResponse =>
    makeResponse({
      ...self,
      status,
      statusText: statusText ?? self.statusText
    })
)

/**
 * @since 4.0.0
 * @category conversions
 */
export const toWeb = (
  response: HttpServerResponse,
  options?: {
    readonly withoutBody?: boolean | undefined
    readonly services?: ServiceMap.ServiceMap<never> | undefined
  }
): Response => {
  const headers = new globalThis.Headers(response.headers)
  if (!Cookies.isEmpty(response.cookies)) {
    const toAdd = Cookies.toSetCookieHeaders(response.cookies)
    for (const header of toAdd) {
      headers.append("set-cookie", header)
    }
  }
  if (options?.withoutBody) {
    return new Response(undefined, {
      status: response.status,
      statusText: response.statusText as string,
      headers
    })
  }
  const body = response.body
  switch (body._tag) {
    case "Empty": {
      return new Response(undefined, {
        status: response.status,
        statusText: response.statusText as string,
        headers
      })
    }
    case "Uint8Array":
    case "Raw": {
      if (body.body instanceof Response) {
        for (const [key, value] of headers as any) {
          body.body.headers.set(key, value)
        }
        return body.body
      }
      return new Response(body.body as any, {
        status: response.status,
        statusText: response.statusText!,
        headers
      })
    }
    case "FormData": {
      return new Response(body.formData as any, {
        status: response.status,
        statusText: response.statusText!,
        headers
      })
    }
    case "Stream": {
      return new Response(
        Stream.toReadableStreamWith(
          body.stream,
          options?.services ?? ServiceMap.empty()
        ),
        {
          status: response.status,
          statusText: response.statusText!,
          headers
        }
      )
    }
  }
}

/**
 * @since 4.0.0
 * @category conversions
 */
export const toClientResponse = (
  response: HttpServerResponse,
  options?: {
    readonly request?: HttpClientRequest.HttpClientRequest | undefined
  }
): HttpClientResponse.HttpClientResponse =>
  new ServerHttpClientResponse(
    options?.request ?? HttpClientRequest.empty,
    response
  )

class ServerHttpClientResponse extends Inspectable.Class implements HttpClientResponse.HttpClientResponse, Pipeable {
  readonly [HttpIncomingMessage.TypeId]: typeof HttpIncomingMessage.TypeId
  readonly [HttpClientResponse.TypeId]: typeof HttpClientResponse.TypeId

  readonly request: HttpClientRequest.HttpClientRequest
  private readonly response: HttpServerResponse

  constructor(
    request: HttpClientRequest.HttpClientRequest,
    response: HttpServerResponse
  ) {
    super()
    this.request = request
    this.response = response
    this[HttpIncomingMessage.TypeId] = HttpIncomingMessage.TypeId
    this[HttpClientResponse.TypeId] = HttpClientResponse.TypeId
  }

  toJSON(): unknown {
    return HttpIncomingMessage.inspect(this, {
      _id: "HttpClientResponse",
      request: this.request.toJSON(),
      status: this.status
    })
  }

  get status(): number {
    return this.response.status
  }

  private cachedHeaders?: Headers.Headers
  get headers(): Headers.Headers {
    return this.cachedHeaders ??= this.response.body._tag === "FormData"
      ? Headers.merge(this.response.headers, Headers.fromInput(this.getFormDataResponse().headers))
      : this.response.headers
  }

  get cookies(): Cookies.Cookies {
    return this.response.cookies
  }

  get remoteAddress(): Option.Option<string> {
    return Option.none()
  }

  get stream(): Stream.Stream<Uint8Array, HttpClientError.HttpClientError> {
    const body = this.response.body
    switch (body._tag) {
      case "Empty": {
        return Stream.empty
      }
      case "Stream": {
        return Stream.mapError(body.stream, (cause) => this.decodeError(cause))
      }
      case "Uint8Array": {
        return Stream.succeed(body.body)
      }
      case "Raw": {
        const rawBody = body.body
        if (rawBody instanceof Response) {
          return rawBody.body
            ? Stream.fromReadableStream({
              evaluate: () => rawBody.body!,
              onError: (cause) => this.decodeError(cause)
            })
            : Stream.empty
        }
        if (isReadableStream(rawBody)) {
          return Stream.fromReadableStream({
            evaluate: () => rawBody,
            onError: (cause) => this.decodeError(cause)
          })
        }
        if (rawBody instanceof Blob) {
          return Stream.fromReadableStream({
            evaluate: () => rawBody.stream(),
            onError: (cause) => this.decodeError(cause)
          })
        }
        return Stream.unwrap(Effect.map(this.bytes, Stream.succeed))
      }
      case "FormData": {
        const response = this.getFormDataResponse()
        return Stream.fromReadableStream({
          evaluate: () => response.body!,
          onError: (cause) => this.decodeError(cause)
        })
      }
    }
  }

  get json(): Effect.Effect<Schema.Json, HttpClientError.HttpClientError> {
    return Effect.flatMap(this.text, (text) =>
      Effect.try({
        try: () => text === "" ? null : JSON.parse(text),
        catch: (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.DecodeError({
              request: this.request,
              response: this,
              cause
            })
          })
      }))
  }

  private get bytes(): Effect.Effect<Uint8Array, HttpClientError.HttpClientError> {
    const body = this.response.body
    switch (body._tag) {
      case "Empty": {
        return Effect.succeed(new Uint8Array(0))
      }
      case "Uint8Array": {
        return Effect.succeed(body.body)
      }
      case "Stream": {
        return Stream.mkUint8Array(this.stream)
      }
      case "Raw": {
        const rawBody = body.body
        if (rawBody instanceof Response) {
          return Effect.tryPromise({
            try: () => rawBody.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
            catch: (cause) => this.decodeError(cause)
          })
        }
        return Effect.tryPromise({
          try: () => new Response(rawBody as any).arrayBuffer().then((buffer) => new Uint8Array(buffer)),
          catch: (cause) => this.decodeError(cause)
        })
      }
      case "FormData": {
        return Effect.tryPromise({
          try: () => new Response(body.formData).arrayBuffer().then((buffer) => new Uint8Array(buffer)),
          catch: (cause) => this.decodeError(cause)
        })
      }
    }
  }

  get text(): Effect.Effect<string, HttpClientError.HttpClientError> {
    return Effect.map(this.bytes, (bytes) => textDecoder.decode(bytes))
  }

  get urlParamsBody(): Effect.Effect<UrlParams.UrlParams, HttpClientError.HttpClientError> {
    return Effect.flatMap(this.text, (_) =>
      Effect.try({
        try: () => UrlParams.fromInput(new URLSearchParams(_)),
        catch: (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.DecodeError({
              request: this.request,
              response: this,
              cause
            })
          })
      }))
  }

  get formData(): Effect.Effect<FormData, HttpClientError.HttpClientError> {
    const body = this.response.body
    if (body._tag === "FormData") {
      return Effect.succeed(body.formData)
    }
    return Effect.servicesWith((services: ServiceMap.ServiceMap<never>) => {
      const readableStream = Stream.toReadableStreamWith(this.stream, services)
      return Effect.tryPromise({
        try: () => new Response(readableStream, { headers: this.headers }).formData(),
        catch: (cause) => this.decodeError(cause)
      })
    })
  }

  get arrayBuffer(): Effect.Effect<ArrayBuffer, HttpClientError.HttpClientError> {
    return Effect.map(this.bytes, (bytes) => bytes.slice().buffer)
  }

  private decodeError(cause: unknown): HttpClientError.HttpClientError {
    return new HttpClientError.HttpClientError({
      reason: new HttpClientError.DecodeError({
        request: this.request,
        response: this,
        cause
      })
    })
  }

  private formDataResponse?: Response
  private getFormDataResponse(): Response {
    return this.formDataResponse ??= new Response((this.response.body as Body.FormData).formData)
  }

  pipe() {
    return pipeArguments(this, arguments)
  }
}

const textDecoder = new TextDecoder()

/**
 * @since 4.0.0
 * @category conversions
 */
export const fromClientResponse = (
  response: HttpClientResponse.HttpClientResponse
): HttpServerResponse => {
  const headers = Headers.remove(response.headers, "set-cookie")
  return makeResponse({
    status: response.status,
    headers,
    cookies: response.cookies,
    body: Body.stream(
      Stream.catchIf(response.stream, isEmptyBodyError, () => Stream.empty),
      Option.getOrUndefined(Headers.get(headers, "content-type")),
      getContentLength(headers)
    )
  })
}

const isReadableStream = (u: unknown): u is ReadableStream<Uint8Array> =>
  typeof ReadableStream !== "undefined" && u instanceof ReadableStream

const isEmptyBodyError = (
  error: HttpClientError.HttpClientError
): error is HttpClientError.HttpClientError =>
  HttpClientError.isHttpClientError(error) && error.reason._tag === "EmptyBodyError"

const getContentLength = (headers: Headers.Headers): number | undefined => {
  const contentLength = Option.getOrUndefined(Headers.get(headers, "content-length"))
  if (contentLength === undefined) {
    return undefined
  }
  const parsed = Number(contentLength)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

const Proto: Omit<
  HttpServerResponse,
  "status" | "statusText" | "headers" | "cookies" | "body"
> = {
  ...PipeInspectableProto,
  [TypeId]: TypeId,
  [ErrorReporter.ignore]: true,
  toJSON(this: HttpServerResponse) {
    return {
      _id: "HttpServerResponse",
      status: this.status,
      statusText: this.statusText,
      headers: redact(this.headers),
      cookies: this.cookies.toJSON(),
      body: this.body.toJSON()
    }
  }
}

const makeResponse = (options: {
  readonly status: number
  readonly statusText?: string | undefined
  readonly headers?: Headers.Headers | undefined
  readonly cookies?: Cookies.Cookies | undefined
  readonly body?: Body.HttpBody | undefined
}) => {
  const self = Object.create(Proto) as Mutable<HttpServerResponse>
  self.status = options.status
  self.statusText = options.statusText
  self.cookies = options.cookies ?? Cookies.empty
  self.body = options.body ?? Body.empty
  if (
    self.body._tag !== "Empty" &&
    (self.body.contentType || self.body.contentLength)
  ) {
    const newHeaders = Headers.fromRecordUnsafe({ ...options.headers }) as any
    if (self.body.contentType) {
      newHeaders["content-type"] = self.body.contentType
    }
    if (self.body.contentLength) {
      newHeaders["content-length"] = self.body.contentLength.toString()
    }
    self.headers = newHeaders
  } else {
    self.headers = options.headers ?? Headers.empty
  }
  return self
}

/**
 * @since 4.0.0
 * @category conversions
 */
export const fromWeb = (response: Response): HttpServerResponse => {
  const headers = new globalThis.Headers(response.headers)
  const setCookieHeaders = headers.getSetCookie()
  headers.delete("set-cookie")
  let self = empty({
    status: response.status,
    statusText: response.statusText,
    headers: headers as any,
    cookies: Cookies.fromSetCookie(setCookieHeaders)
  })
  if (response.body) {
    const contentType = response.headers.get("content-type")
    self = setBody(
      self,
      Body.stream(
        Stream.fromReadableStream({
          evaluate: () => response.body!,
          onError: (e) => e
        }),
        contentType ?? undefined
      )
    )
  }
  return self
}
