import { Cause, Exit } from "effect"
import { HttpClientError } from "effect/unstable/http"

export interface FormattedError {
	readonly title: string
	readonly description: string
}

const QUOTA_DESCRIPTIONS: Record<string, string> = {
	max_execution_time: "Query exceeded the 30s execution limit. Narrow the time range or add filters.",
	max_memory_usage: "Query exceeded the memory limit. Add filters or reduce cardinality.",
	max_threads: "Query exceeded the thread limit. Try a smaller scan.",
}

const hasTag = (value: unknown): value is { _tag: string; [key: string]: unknown } =>
	typeof value === "object" &&
	value !== null &&
	"_tag" in value &&
	typeof (value as { _tag: unknown })._tag === "string"

const sanitizeMessage = (raw: string): string => {
	let cleaned = raw
	const htmlIndex = cleaned.search(/<\s*(html|head|body|center|h1|hr|title)\b/i)
	if (htmlIndex >= 0) cleaned = cleaned.slice(0, htmlIndex)
	cleaned = cleaned
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim()
	if (cleaned.endsWith(":")) cleaned = cleaned.slice(0, -1).trim()
	return cleaned || raw.slice(0, 200)
}

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

const numberField = (value: unknown, key: string): number | undefined => {
	if (typeof value === "object" && value !== null && key in value) {
		const v = (value as Record<string, unknown>)[key]
		if (typeof v === "number") return v
	}
	return undefined
}

const unwrap = (error: unknown): unknown => {
	if (Cause.isCause(error)) {
		return Cause.squash(error)
	}
	if (Exit.isExit(error)) {
		const found = Exit.isFailure(error) ? Cause.squash(error.cause) : undefined
		if (found !== undefined) return found
	}
	return error
}

export const formatBackendError = (input: unknown): FormattedError => {
	const error = unwrap(input)

	if (hasTag(error)) {
		switch (error._tag) {
			case "@maple/http/errors/TinybirdQuotaExceededError": {
				const setting = stringField(error, "setting") ?? "limit"
				return {
					title: "Query was too expensive",
					description:
						QUOTA_DESCRIPTIONS[setting] ??
						`Query exceeded the ${setting} limit. Narrow the time range or add filters.`,
				}
			}
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
					title: "Invalid query parameters",
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
			case "@maple/http/errors/TinybirdQueryError": {
				const message = stringField(error, "message") ?? "Database query failed"
				const category = stringField(error, "category")
				const upstreamStatus =
					numberField(error, "upstreamStatus") ??
					(message.match(/status[:\s]+(\d{3})/i)?.[1]
						? Number(message.match(/status[:\s]+(\d{3})/i)?.[1])
						: undefined)
				if (category === "auth" || upstreamStatus === 401 || upstreamStatus === 403) {
					return {
						title: "Database rejected our credentials",
						description:
							upstreamStatus === 403
								? "The configured database credentials are missing required permissions."
								: "The configured database credentials are invalid or expired. Update them in settings.",
					}
				}
				if (
					category === "upstream" ||
					(upstreamStatus !== undefined && upstreamStatus >= 500 && upstreamStatus < 600)
				) {
					return {
						title: "Database is temporarily unavailable",
						description:
							upstreamStatus !== undefined
								? `The query backend returned ${upstreamStatus}. Retry in a few seconds.`
								: "The query backend is unreachable. Retry in a few seconds.",
					}
				}
				if (category === "config") {
					return {
						title: "Database is not configured correctly",
						description: message,
					}
				}
				if (category === "client") {
					return {
						title: "Database response could not be decoded",
						description: message,
					}
				}
				return {
					title: "Database query failed",
					description: message,
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
				description: "Check your network connection and try again.",
			}
		}
		if (status !== undefined && status >= 500) {
			return {
				title: "Server error",
				description: error.message ?? `The Maple API returned ${status}.`,
			}
		}
	}

	if (error instanceof Error) {
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

export const formatBackendErrorMessage = (input: unknown): string => {
	const { title, description } = formatBackendError(input)
	return `${title} — ${description}`
}
