import { Schema } from "effect"

/** Recovery actions understood by both the HTTP boundary and Maple clients. */
export const HttpErrorRecovery = Schema.Literals([
	"none",
	"fix_request",
	"reauthenticate",
	"request_access",
	"reconnect",
	"refresh",
	"retry",
	"contact_support",
])
export type HttpErrorRecovery = Schema.Schema.Type<typeof HttpErrorRecovery>

export type HttpErrorRetry = "never" | "backoff" | "after"
export type HttpErrorOrigin = "client" | "maple" | "dependency"
export type HttpErrorExposure = "public_message" | "redacted"

/**
 * Static semantics owned by one domain error tag.
 *
 * HTTP status remains on the error schema annotation. Keeping it out of this
 * object prevents two sources of truth from drifting apart.
 */
export interface HttpErrorPolicy {
	readonly title: string
	readonly retry: HttpErrorRetry
	readonly recovery: HttpErrorRecovery
	readonly origin: HttpErrorOrigin
	readonly exposure: HttpErrorExposure
}

/** One exhaustive policy table per tagged-error union. */
export const defineHttpErrorPolicies =
	<Tag extends string>() =>
	<const Policies extends Record<Tag, HttpErrorPolicy>>(policies: Policies): Policies =>
		policies

export const isHttpErrorRetryable = (policy: HttpErrorPolicy): boolean => policy.retry !== "never"

/** Metadata copied by the generic v2 envelope constructors. */
export const httpErrorMetadata = (
	tag: string,
	policy: HttpErrorPolicy,
	dynamic: {
		readonly retryAfterSeconds?: number
		readonly retryAt?: string
	} = {},
) => ({
	tag,
	title: policy.title,
	retryable: isHttpErrorRetryable(policy),
	recovery: policy.recovery,
	...(dynamic.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: dynamic.retryAfterSeconds }),
	...(dynamic.retryAt === undefined ? {} : { retryAt: dynamic.retryAt }),
})
