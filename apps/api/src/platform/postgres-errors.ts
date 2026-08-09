import type { DatabaseError } from "./DatabaseLive"

const RETRYABLE_CONTENTION_CODES: ReadonlySet<string> = new Set(["40001", "40P01"])
const RETRYABLE_CONTENTION_MESSAGE = /\b(?:40001|40P01)\b/

const causeCode = (cause: unknown): string | undefined => {
	if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined
	const code = (cause as { readonly code?: unknown }).code
	return typeof code === "string" ? code : undefined
}

const causeMessage = (cause: unknown): string | undefined => {
	if (cause instanceof Error) return cause.message
	return typeof cause === "string" ? cause : undefined
}

/** PostgreSQL failures that are safe to retry as a fresh transaction attempt. */
export const isRetryablePostgresContention = (error: DatabaseError): boolean => {
	if (RETRYABLE_CONTENTION_MESSAGE.test(error.message)) return true
	const code = causeCode(error.cause)
	if (code !== undefined && RETRYABLE_CONTENTION_CODES.has(code)) return true
	const innerMessage = causeMessage(error.cause)
	return innerMessage !== undefined && RETRYABLE_CONTENTION_MESSAGE.test(innerMessage)
}
