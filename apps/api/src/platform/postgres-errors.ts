// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
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

/**
 * postgres.js codes for failures to establish or keep a connection, as opposed
 * to failures of a statement. `CONNECT_TIMEOUT` is the one `connect_timeout`
 * raises; the `E*` codes come straight from the socket.
 */
const CONNECTION_ERROR_CODES: ReadonlySet<string> = new Set([
	"CONNECT_TIMEOUT",
	"CONNECTION_CLOSED",
	"CONNECTION_DESTROYED",
	"CONNECTION_ENDED",
	"CONNECTION_REFUSED",
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ENOTFOUND",
	"ETIMEDOUT",
])

/** SQLSTATE: five alphanumerics, e.g. `23505`, `40001`, `57014`. */
const SQLSTATE = /^[0-9A-Z]{5}$/

const nestedCause = (cause: unknown): unknown =>
	cause instanceof Error && cause.cause !== undefined ? cause.cause : undefined

const errorCode = (error: DatabaseError): string | undefined =>
	causeCode(error.cause) ?? causeCode(nestedCause(error.cause))

/**
 * A machine-readable class for the failure, for the span's `error.type`.
 *
 * `toDatabaseError` flattens everything into a message string, which made a
 * dial timeout indistinguishable from a constraint violation once it reached a
 * trace — the reason repeated investigations could not separate connection
 * failures from query failures. The driver's own code is that distinction, so
 * emit it verbatim rather than inventing a taxonomy.
 */
export const postgresErrorType = (error: DatabaseError): string | undefined => {
	const code = errorCode(error)
	if (code !== undefined) return code
	if (error.cause instanceof Error && error.cause.name !== "Error") return error.cause.name
	return undefined
}

/** SQLSTATE for a statement failure, or undefined for connection-class failures. */
export const postgresSqlState = (error: DatabaseError): string | undefined => {
	const code = errorCode(error)
	return code !== undefined && SQLSTATE.test(code) ? code : undefined
}

/**
 * True when the failure is the connection rather than the statement.
 *
 * Worth separating in dashboards: connection failures track the Worker's
 * six-slot outbound budget and say nothing about the query, so mixing them into
 * a single database-error rate hides both signals.
 */
export const isPostgresConnectionError = (error: DatabaseError): boolean => {
	const code = errorCode(error)
	return code !== undefined && CONNECTION_ERROR_CODES.has(code)
}
