// How a span ended, as one value.
//
// The OTLP buffer tracer and the Cloudflare-native tracer must agree on what
// counts as an error: Maple's error tracking reads the verdict either as an
// `exception` event (OTLP) or as `exception.*` attributes (native). One
// classification keeps the two from drifting.
import { Cause, type Exit, Predicate, type Tracer } from "effect"
import * as ErrorReporter from "effect/ErrorReporter"

export type SpanOutcome =
	| { readonly _tag: "Success" }
	/** Interrupt-only cause — not an error, but worth flagging. */
	| { readonly _tag: "Interrupted" }
	/**
	 * Every failure carries `[ErrorReporter.ignore]`, Effect's own "don't report
	 * this" signal (the canonical case is `HttpServerError` / `RouteNotFound`).
	 */
	| { readonly _tag: "Ignored" }
	/** Every failure is in the caller's `anticipatedErrorIdentifiers` (an expected 4xx). */
	| { readonly _tag: "Anticipated" }
	| { readonly _tag: "Failed"; readonly errors: ReadonlyArray<Error> }
	/** A SERVER span that succeeded but answered 5xx — an error by OTEL HTTP semconv. */
	| { readonly _tag: "ServerError"; readonly statusCode: number; readonly message: string }

/** `exception.type` recorded for a rendered 5xx response, on both tracers. */
export const HTTP_SERVER_ERROR_RESPONSE = "HttpServerErrorResponse"

export interface EndedSpan {
	readonly exit: Exit.Exit<unknown, unknown>
	readonly kind: Tracer.SpanKind
	readonly attributes: ReadonlyMap<string, unknown>
}

const isIgnoredFailure = (error: unknown): boolean =>
	Predicate.hasProperty(error, ErrorReporter.ignore) && error[ErrorReporter.ignore] === true

// An error that crossed an HTTP boundary arrives as a decoded *body*, not as
// the class that raised it. An API that wraps its bodies in `{ error: … }`
// would otherwise leave every configured identifier unmatched, so unwrap one
// level, and only for the body's own tag.
const failureIdentifier = (error: unknown): string | undefined => {
	if (Predicate.hasProperty(error, "_tag") && typeof error._tag === "string") return error._tag
	if (Predicate.hasProperty(error, "name") && typeof error.name === "string") return error.name
	const body = Predicate.hasProperty(error, "error") ? error.error : undefined
	if (Predicate.hasProperty(body, "_tag") && typeof body._tag === "string") return body._tag
	return undefined
}

const isAnticipatedFailure = (error: unknown, identifiers: ReadonlySet<string>): boolean => {
	const identifier = failureIdentifier(error)
	return identifier !== undefined && identifiers.has(identifier)
}

// OTEL HTTP semconv for SERVER spans: a 5xx response is an error even when the
// handler rendered it as a plain response — exactly what the HTTP boundaries
// (`HttpRouter.toWebHandler`, a Worker bridge) do with a defect, so the span
// would otherwise reach the warehouse as `Ok` and the crash never reach error
// tracking. A 4xx is a rejection the service handled and stays `Ok`.
const renderedServerError = (span: EndedSpan): number | undefined => {
	if (span.kind !== "server") return undefined
	const raw = span.attributes.get("http.response.status_code")
	const code = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN
	return Number.isInteger(code) && code >= 500 ? code : undefined
}

const serverErrorMessage = (span: EndedSpan, statusCode: number): string => {
	const method = span.attributes.get("http.request.method")
	const path = span.attributes.get("url.path")
	return typeof method === "string" && typeof path === "string"
		? `HTTP ${statusCode} (${method} ${path})`
		: `HTTP ${statusCode}`
}

/**
 * Classify how a span ended. A cause that mixes an ignored or anticipated
 * failure with a defect (`Die`) is a real failure — only causes made entirely
 * of benign failures are downgraded. A successful SERVER span still classifies
 * as `ServerError` when it answered 5xx.
 */
export const classifySpanExit = (
	span: EndedSpan,
	anticipatedErrorIdentifiers: ReadonlySet<string> | undefined,
): SpanOutcome => {
	const exit = span.exit
	if (exit._tag === "Success") {
		const statusCode = renderedServerError(span)
		return statusCode === undefined
			? { _tag: "Success" }
			: { _tag: "ServerError", statusCode, message: serverErrorMessage(span, statusCode) }
	}
	const cause = exit.cause
	if (Cause.hasInterruptsOnly(cause)) return { _tag: "Interrupted" }
	if (!cause.reasons.some(Cause.isDieReason)) {
		const failures = cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)
		if (failures.length > 0) {
			if (failures.every(isIgnoredFailure)) return { _tag: "Ignored" }
			if (
				anticipatedErrorIdentifiers !== undefined &&
				anticipatedErrorIdentifiers.size > 0 &&
				failures.every((error) => isAnticipatedFailure(error, anticipatedErrorIdentifiers))
			) {
				return { _tag: "Anticipated" }
			}
		}
	}
	return { _tag: "Failed", errors: Cause.prettyErrors(cause) }
}
