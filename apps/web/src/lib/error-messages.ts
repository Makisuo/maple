import { Cause, Exit, Option } from "effect"
import { HttpClientError } from "effect/unstable/http"
import {
	cleanErrorMessage,
	isWarehouseErrorTag,
	presentWarehouseError,
	type WarehouseErrorLike,
} from "@maple/domain"
import { isChunkLoadError } from "./chunk-reload"

export interface FormattedError {
	readonly title: string
	readonly description: string
	/** `"network"` = transient connectivity failure; safe to auto-retry. */
	readonly kind?: "network"
}

const hasTag = (value: unknown): value is { _tag: string; [key: string]: unknown } =>
	typeof value === "object" &&
	value !== null &&
	"_tag" in value &&
	typeof (value as { _tag: unknown })._tag === "string"

const sanitizeMessage = cleanErrorMessage

const stringField = (value: unknown, key: string): string | undefined => {
	if (typeof value === "object" && value !== null && key in value) {
		const v = (value as Record<string, unknown>)[key]
		if (typeof v === "string") return sanitizeMessage(v)
	}
	return undefined
}

const stringArrayField = (value: unknown, key: string): ReadonlyArray<string> | undefined => {
	if (typeof value === "object" && value !== null && key in value) {
		const v = (value as Record<string, unknown>)[key]
		if (Array.isArray(v)) return v.filter((item): item is string => typeof item === "string")
	}
	return undefined
}

const unwrap = (error: unknown): unknown => {
	if (Cause.isCause(error)) {
		return Option.getOrElse(Cause.findErrorOption(error), () => error)
	}
	if (Exit.isExit(error)) {
		return Option.getOrElse(Exit.findErrorOption(error), () => error)
	}
	return error
}

export interface V2ErrorInfo {
	readonly type: string
	readonly code: string
	readonly message: string
}

/**
 * Extract the v2 API error envelope (`{ error: { type, code, message } }`)
 * from a failure, unwrapping Cause/Exit first. Returns null for anything that
 * isn't a v2-shaped error, so callers can fall through to the v1 handling.
 */
export const v2ErrorInfo = (input: unknown): V2ErrorInfo | null => {
	const error = unwrap(input)
	if (typeof error !== "object" || error === null || !("error" in error)) return null
	const body = (error as { error: unknown }).error
	const type = stringField(body, "type")
	const code = stringField(body, "code")
	const message = stringField(body, "message")
	if (type === undefined || code === undefined || message === undefined) return null
	return { type, code, message }
}

const V2_ERROR_TITLES: Record<string, string> = {
	invalid_request_error: "Invalid request",
	authentication_error: "Not authorized",
	permission_error: "Not authorized",
	not_found_error: "Not found",
	conflict_error: "Conflict",
	rate_limit_error: "Rate limited",
	api_error: "Server error",
}

export const formatBackendError = (input: unknown): FormattedError => {
	const error = unwrap(input)

	const v2 = v2ErrorInfo(error)
	if (v2 !== null) {
		return {
			title: V2_ERROR_TITLES[v2.type] ?? "Something went wrong",
			description: v2.message,
		}
	}

	// All nine warehouse tags share one presenter in @maple/domain
	// (warehouse-error-meta) — the same copy the API surfaces elsewhere, and the
	// one place a new warehouse tag must be described.
	if (hasTag(error) && isWarehouseErrorTag(error._tag)) {
		const like: WarehouseErrorLike = {
			_tag: error._tag,
			...(typeof error.message === "string" ? { message: error.message } : {}),
			...(typeof error.setting === "string" ? { setting: error.setting } : {}),
			...(typeof error.upstreamStatus === "number" ? { upstreamStatus: error.upstreamStatus } : {}),
			...(typeof error.kind === "string" ? { kind: error.kind } : {}),
		}
		return presentWarehouseError(like)
	}

	if (hasTag(error)) {
		switch (error._tag) {
			case "@maple/http/errors/QueryEngineTimeoutError": {
				return {
					title: "Query timed out",
					description:
						"The query took longer than 30 seconds. Narrow the time range or add filters.",
				}
			}
			case "@maple/http/errors/QueryEngineValidationError": {
				const message = stringField(error, "message") ?? "Invalid query parameters"
				const details = stringArrayField(error, "details") ?? []
				return {
					// The engine's `message` is the specific headline ("List query time
					// range too large"); a generic title here discarded it whenever
					// `details` was populated, which is nearly always.
					title: message,
					description: details.length > 0 ? details.join("; ") : message,
				}
			}
			case "@maple/http/errors/QueryEngineExecutionError": {
				const message = stringField(error, "message") ?? "Query execution failed"
				const causeMessage = stringField(error, "causeMessage")
				return {
					title: "Query failed",
					description: causeMessage ? `${message}: ${causeMessage}` : message,
				}
			}
			case "@maple/http/errors/UnauthorizedError": {
				return {
					title: "Not authorized",
					description:
						"Your session may have expired. Try refreshing the page or signing in again.",
				}
			}
		}
	}

	if (HttpClientError.isHttpClientError(error)) {
		const reasonTag = error.reason._tag
		const status =
			"response" in error.reason && error.reason.response ? error.reason.response.status : undefined
		if (status === 401 || status === 403) {
			return {
				title: "Not authorized",
				description: "Your session may have expired. Try refreshing the page or signing in again.",
			}
		}
		if (status === 429) {
			return {
				title: "Rate limited",
				description: "Too many requests. Wait a moment and try again.",
			}
		}
		if (status === 504) {
			return {
				title: "Query timed out",
				description: "The request took too long to complete. Narrow the time range or add filters.",
			}
		}
		if (reasonTag === "TransportError" || reasonTag === "InvalidUrlError") {
			return {
				title: "Cannot reach Maple API",
				description: "Check your connection — data will resume once the API is reachable.",
				// A bad URL never self-heals — only transport failures auto-retry.
				...(reasonTag === "TransportError" ? { kind: "network" as const } : {}),
			}
		}
		if (status !== undefined && status >= 500) {
			return {
				title: "Server error",
				description: error.message ?? `The Maple API returned ${status}.`,
			}
		}
	}

	if (isChunkLoadError(error)) {
		return {
			title: "Maple was updated",
			description: "Reloading to pick up the new version…",
		}
	}

	if (error instanceof Error) {
		// Transport-level failures carry request URLs in their message — swap the
		// internals for actionable copy.
		if (/transport error|failed to fetch|load failed|networkerror/i.test(error.message)) {
			return {
				title: "Cannot reach Maple API",
				description: "Check your connection — data will resume once the API is reachable.",
				kind: "network",
			}
		}
		return {
			title: "Something went wrong",
			description: error.message || "An unexpected error occurred.",
		}
	}

	const message = stringField(error, "message")
	if (message) {
		return {
			title: "Something went wrong",
			description: message,
		}
	}

	return {
		title: "Something went wrong",
		description: typeof error === "string" ? error : "An unexpected error occurred.",
	}
}
