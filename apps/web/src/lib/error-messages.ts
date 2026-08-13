import { Cause, Exit, Option, Schema } from "effect"
import { HttpClientError } from "effect/unstable/http"
import {
	PublicHttpErrorBodySchema,
	type AnyPublicHttpErrorBody,
	type HttpErrorRecovery,
} from "@maple/domain/http"
import { isChunkLoadError } from "./chunk-reload"

export const NetworkErrorTag = "@maple/web/errors/NetworkError" as const
export const UnexpectedErrorTag = "@maple/web/errors/UnexpectedError" as const

export interface ClientErrorDefinition {
	readonly _tag: `@maple/web/errors/${string}`
	readonly code: string
	readonly title: string
	readonly message: string
	readonly retryable: boolean
	readonly recovery: HttpErrorRecovery
}

export const makeClientErrorBody = (definition: ClientErrorDefinition): AnyPublicHttpErrorBody => ({
	type: "api_error",
	...definition,
})

const NetworkError = makeClientErrorBody({
	_tag: NetworkErrorTag,
	code: "network_unreachable",
	title: "Cannot reach Maple API",
	message: "Check your connection. Data will resume once the API is reachable.",
	retryable: true,
	recovery: "retry",
})

const TimeoutError = makeClientErrorBody({
	_tag: "@maple/web/errors/TimeoutError",
	code: "request_timeout",
	title: "Request timed out",
	message: "The API did not respond in time. Try again when you're ready.",
	retryable: true,
	recovery: "retry",
})

const InvalidUrlError = makeClientErrorBody({
	_tag: "@maple/web/errors/InvalidUrlError",
	code: "invalid_request_url",
	title: "This request could not be sent",
	message: "Reload Maple. If the problem continues, contact support.",
	retryable: false,
	recovery: "refresh",
})

const HttpRequestError = makeClientErrorBody({
	_tag: "@maple/web/errors/HttpRequestError",
	code: "http_request_failed",
	title: "The request failed",
	message: "Maple could not complete this request.",
	retryable: false,
	recovery: "none",
})

const StaleChunkError = makeClientErrorBody({
	_tag: "@maple/web/errors/StaleChunkError",
	code: "stale_chunk",
	title: "Maple was updated",
	message: "Reload to use the latest version.",
	retryable: false,
	recovery: "refresh",
})

const UnexpectedError = makeClientErrorBody({
	_tag: UnexpectedErrorTag,
	code: "unexpected_error",
	title: "Something went wrong",
	message: "An unexpected error occurred. Try again, or reload if the problem continues.",
	retryable: false,
	recovery: "refresh",
})

const isPublicErrorBody = Schema.is(PublicHttpErrorBodySchema)

const unwrap = (error: unknown): unknown => {
	if (Cause.isCause(error)) return Option.getOrElse(Cause.findErrorOption(error), () => error)
	if (Exit.isExit(error)) return Option.getOrElse(Exit.findErrorOption(error), () => error)
	return error
}

const nestedCause = (value: unknown): unknown =>
	typeof value === "object" && value !== null && "cause" in value
		? (value as { readonly cause: unknown }).cause
		: undefined

/** Read the public body shared by decoded HTTP responses and live tagged errors. */
export const publicError = (input: unknown): AnyPublicHttpErrorBody | null => {
	const value = unwrap(input)
	if (isPublicErrorBody(value)) return value
	if (typeof value !== "object" || value === null || !("error" in value)) return null
	const body = (value as { readonly error: unknown }).error
	return isPublicErrorBody(body) ? body : null
}

const isTimeoutException = (value: unknown): boolean =>
	typeof DOMException !== "undefined" && value instanceof DOMException && value.name === "TimeoutError"

const displayErrorInternal = (input: unknown, depth: number): AnyPublicHttpErrorBody => {
	const value = unwrap(input)
	const declared = publicError(value)
	if (declared !== null) return declared

	if (HttpClientError.isHttpClientError(value)) {
		if (value.reason._tag === "TransportError") {
			return isTimeoutException(value.reason.cause) ? TimeoutError : NetworkError
		}
		return value.reason._tag === "InvalidUrlError" ? InvalidUrlError : HttpRequestError
	}

	if (isChunkLoadError(value)) return StaleChunkError

	const cause = nestedCause(value)
	if (depth < 4 && cause !== undefined && cause !== value) {
		const nested = displayErrorInternal(cause, depth + 1)
		if (nested._tag !== UnexpectedErrorTag) return nested
	}

	return UnexpectedError
}

/** Resolve any application failure to the single safe public error contract. */
export const displayError = (input: unknown): AnyPublicHttpErrorBody => displayErrorInternal(input, 0)

export const isAutomaticRetryError = (error: AnyPublicHttpErrorBody): boolean =>
	error._tag === NetworkErrorTag

export const isUnexpectedError = (error: AnyPublicHttpErrorBody): boolean => error._tag === UnexpectedErrorTag
