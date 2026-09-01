// How a span ended, as one value.
//
// The OTLP buffer tracer and the Cloudflare-native tracer must agree on what
// counts as an error: Maple's error tracking reads the verdict either as an
// `exception` event (OTLP) or as `exception.*` attributes (native). One
// classification keeps the two from drifting.
import { Cause, type Exit, Predicate } from "effect"
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

/**
 * Classify a span's exit. A cause that mixes an ignored or anticipated failure
 * with a defect (`Die`) is a real failure — only causes made entirely of
 * benign failures are downgraded.
 */
export const classifySpanExit = (
	exit: Exit.Exit<unknown, unknown>,
	anticipatedErrorIdentifiers: ReadonlySet<string> | undefined,
): SpanOutcome => {
	if (exit._tag === "Success") return { _tag: "Success" }
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
