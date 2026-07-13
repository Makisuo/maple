import { Cause, Exit, Option } from "effect"
import { HttpClientError } from "effect/unstable/http"
import { isChunkLoadError } from "./chunk-reload"

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
		return Option.getOrElse(Cause.findErrorOption(error), () => error)
	}
	if (Exit.isExit(error)) {
		return Option.getOrElse(Exit.findErrorOption(error), () => error)
	}
	return error
}

export const formatBackendError = (input: unknown): FormattedError => {
	const error = unwrap(input)

	if (hasTag(error)) {
		switch (error._tag) {
			case "@maple/http/errors/WarehouseQuotaExceededError": {
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
			case "@maple/http/errors/WarehouseAuthError": {
				const upstreamStatus = numberField(error, "upstreamStatus")
				return {
					title: "Database rejected our credentials",
					description:
						upstreamStatus === 403
							? "The configured database credentials are missing required permissions."
							: "The configured database credentials are invalid or expired. Update them in settings.",
				}
			}
			case "@maple/http/errors/WarehouseUpstreamError": {
				const upstreamStatus = numberField(error, "upstreamStatus")
				return {
					title: "Database is temporarily unavailable",
					description:
						upstreamStatus !== undefined
							? `The query backend returned ${upstreamStatus}. Retry in a few seconds.`
							: "The query backend is unreachable. Retry in a few seconds.",
				}
			}
			case "@maple/http/errors/WarehouseConfigError": {
				return {
					title: "Database is not configured correctly",
					description: stringField(error, "message") ?? "Database is not configured correctly.",
				}
			}
			case "@maple/http/errors/WarehouseClientError": {
				return {
					title: "Database response could not be decoded",
					description: stringField(error, "message") ?? "Database response could not be decoded.",
				}
			}
			case "@maple/http/errors/WarehouseSchemaDriftError": {
				const message = stringField(error, "message")
				return {
					title: "Database schema is out of date",
					description: `${message ?? "A column Maple expects is missing from the cluster."} Run schema apply from your ClickHouse settings.`,
				}
			}
			case "@maple/http/errors/WarehouseValidationError": {
				return {
					title: "Invalid query",
					description: stringField(error, "message") ?? "The query was rejected before running.",
				}
			}
			case "@maple/http/errors/WarehouseQueryError": {
				// Generic SQL/query failure. Some transient failures still arrive with
				// only a status code embedded in the message (e.g. a 5xx HTML body),
				// so keep the message-sniff fallback to surface those nicely.
				const message = stringField(error, "message") ?? "Database query failed"
				const sniffed = message.match(/status[:\s]+(\d{3})/i)?.[1]
				const upstreamStatus = sniffed ? Number(sniffed) : undefined
				if (upstreamStatus === 401 || upstreamStatus === 403) {
					return {
						title: "Database rejected our credentials",
						description:
							upstreamStatus === 403
								? "The configured database credentials are missing required permissions."
								: "The configured database credentials are invalid or expired. Update them in settings.",
					}
				}
				if (upstreamStatus !== undefined && upstreamStatus >= 500 && upstreamStatus < 600) {
					return {
						title: "Database is temporarily unavailable",
						description: `The query backend returned ${upstreamStatus}. Retry in a few seconds.`,
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
				description: "Check your network connection and try again.",
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
