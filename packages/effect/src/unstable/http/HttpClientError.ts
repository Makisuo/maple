/**
 * @since 4.0.0
 */
import * as Data from "../../Data.ts"
import { hasProperty } from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"
import type * as HttpClientRequest from "./HttpClientRequest.ts"
import type * as ClientResponse from "./HttpClientResponse.ts"

const TypeId = "~effect/http/HttpClientError"

/**
 * @since 4.0.0
 * @category guards
 */
export const isHttpClientError = (u: unknown): u is HttpClientError => hasProperty(u, TypeId)

/**
 * @since 4.0.0
 * @category error
 */
export class HttpClientError extends Data.TaggedError("HttpClientError")<{
  readonly reason: HttpClientErrorReason
}> {
  constructor(props: {
    readonly reason: HttpClientErrorReason
  }) {
    if ("cause" in props.reason) {
      super({
        ...props,
        cause: props.reason.cause
      } as any)
    } else {
      super(props)
    }
  }

  /**
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId

  /**
   * @since 4.0.0
   */
  get request(): HttpClientRequest.HttpClientRequest {
    return this.reason.request
  }

  /**
   * @since 4.0.0
   */
  get response(): ClientResponse.HttpClientResponse | undefined {
    return "response" in this.reason ? this.reason.response : undefined
  }

  override get message(): string {
    return this.reason.message
  }
}

const formatReason = (tag: string) => tag.endsWith("Error") ? tag.slice(0, -5) : tag

const formatMessage = (reason: string, description: string | undefined, info: string) =>
  description ? `${reason}: ${description} (${info})` : `${reason} error (${info})`

/**
 * @since 4.0.0
 * @category error
 */
export class TransportError extends Data.TaggedError("TransportError")<{
  readonly request: HttpClientRequest.HttpClientRequest
  readonly cause?: unknown
  readonly description?: string
}> {
  /**
   * @since 4.0.0
   */
  get methodAndUrl() {
    return `${this.request.method} ${this.request.url}`
  }

  /**
   * @since 4.0.0
   */
  override get message() {
    return formatMessage(formatReason(this._tag), this.description, this.methodAndUrl)
  }
}

/**
 * @since 4.0.0
 * @category error
 */
export class EncodeError extends Data.TaggedError("EncodeError")<{
  readonly request: HttpClientRequest.HttpClientRequest
  readonly cause?: unknown
  readonly description?: string
}> {
  /**
   * @since 4.0.0
   */
  get methodAndUrl() {
    return `${this.request.method} ${this.request.url}`
  }

  /**
   * @since 4.0.0
   */
  override get message() {
    return formatMessage(formatReason(this._tag), this.description, this.methodAndUrl)
  }
}

/**
 * @since 4.0.0
 * @category error
 */
export class InvalidUrlError extends Data.TaggedError("InvalidUrlError")<{
  readonly request: HttpClientRequest.HttpClientRequest
  readonly cause?: unknown
  readonly description?: string
}> {
  /**
   * @since 4.0.0
   */
  get methodAndUrl() {
    return `${this.request.method} ${this.request.url}`
  }

  /**
   * @since 4.0.0
   */
  override get message() {
    return formatMessage(formatReason(this._tag), this.description, this.methodAndUrl)
  }
}

/**
 * @since 4.0.0
 * @category error
 */
export class StatusCodeError extends Data.TaggedError("StatusCodeError")<{
  readonly request: HttpClientRequest.HttpClientRequest
  readonly response: ClientResponse.HttpClientResponse
  readonly cause?: unknown
  readonly description?: string | undefined
}> {
  /**
   * @since 4.0.0
   */
  get methodAndUrl() {
    return `${this.request.method} ${this.request.url}`
  }

  /**
   * @since 4.0.0
   */
  override get message() {
    const info = `${this.response.status} ${this.methodAndUrl}`
    return formatMessage(formatReason(this._tag), this.description, info)
  }
}

/**
 * @since 4.0.0
 * @category error
 */
export class DecodeError extends Data.TaggedError("DecodeError")<{
  readonly request: HttpClientRequest.HttpClientRequest
  readonly response: ClientResponse.HttpClientResponse
  readonly cause?: unknown
  readonly description?: string | undefined
}> {
  /**
   * @since 4.0.0
   */
  get methodAndUrl() {
    return `${this.request.method} ${this.request.url}`
  }

  /**
   * @since 4.0.0
   */
  override get message() {
    const info = `${this.response.status} ${this.methodAndUrl}`
    return formatMessage(formatReason(this._tag), this.description, info)
  }
}

/**
 * @since 4.0.0
 * @category error
 */
export class EmptyBodyError extends Data.TaggedError("EmptyBodyError")<{
  readonly request: HttpClientRequest.HttpClientRequest
  readonly response: ClientResponse.HttpClientResponse
  readonly cause?: unknown
  readonly description?: string | undefined
}> {
  /**
   * @since 4.0.0
   */
  get methodAndUrl() {
    return `${this.request.method} ${this.request.url}`
  }

  /**
   * @since 4.0.0
   */
  override get message() {
    const info = `${this.response.status} ${this.methodAndUrl}`
    return formatMessage(formatReason(this._tag), this.description, info)
  }
}

/**
 * @since 4.0.0
 * @category error
 */
export type RequestError = TransportError | EncodeError | InvalidUrlError

/**
 * @since 4.0.0
 * @category error
 */
export type ResponseError = StatusCodeError | DecodeError | EmptyBodyError

/**
 * @since 4.0.0
 * @category error
 */
export type HttpClientErrorReason = RequestError | ResponseError

/**
 * @since 4.0.0
 * @category Schema
 */
export class HttpClientErrorSchema extends Schema.ErrorClass<HttpClientErrorSchema>(TypeId)({
  _tag: Schema.tag("HttpError"),
  kind: Schema.Literals(
    [
      "EncodeError",
      "DecodeError",
      "TransportError",
      "InvalidUrlError",
      "StatusCodeError",
      "EmptyBodyError"
    ] satisfies ReadonlyArray<HttpClientErrorReason["_tag"]>
  ),
  cause: Schema.optional(Schema.Defect)
}) {
  /**
   * @since 4.0.0
   */
  static fromHttpClientError(error: HttpClientError): HttpClientErrorSchema {
    return new HttpClientErrorSchema({
      _tag: "HttpError",
      kind: error.reason._tag,
      cause: error.reason
    })
  }
}
