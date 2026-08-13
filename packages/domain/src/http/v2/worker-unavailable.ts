/**
 * Pure bootstrap-safe policy for the one v2 error that can be emitted before
 * the Effect HTTP graph is available. Keep this module free of Effect imports.
 */
export const v2WorkerUnavailableDefinition = {
	tag: "@maple/http/v2/WorkerUnavailableError",
	status: 504,
	type: "api_error",
	code: "worker_unavailable",
	title: "Maple API is temporarily unavailable",
	message: "Maple API is temporarily unavailable. Retry in a few seconds.",
	retry: "backoff",
	recovery: "retry",
	identifier: "WorkerUnavailableError",
	retryAfterSeconds: 1,
} as const

const isRetryable = (retry: "never" | "backoff" | "after") => retry !== "never"

export const v2WorkerUnavailableBody = () => ({
	_tag: v2WorkerUnavailableDefinition.tag,
	type: v2WorkerUnavailableDefinition.type,
	code: v2WorkerUnavailableDefinition.code,
	title: v2WorkerUnavailableDefinition.title,
	message: v2WorkerUnavailableDefinition.message,
	retryable: isRetryable(v2WorkerUnavailableDefinition.retry),
	recovery: v2WorkerUnavailableDefinition.recovery,
	retry_after_seconds: v2WorkerUnavailableDefinition.retryAfterSeconds,
})
