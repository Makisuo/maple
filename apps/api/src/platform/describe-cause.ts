import { Cause } from "effect"

/** Render an unknown nested cause for logs and serialized persistence errors. */
export const describeCause = (cause: unknown): string | undefined => {
	if (cause == null) return undefined
	if (cause instanceof Error) return cause.stack ?? cause.message
	if (typeof cause === "string") return cause
	try {
		return JSON.stringify(cause)
	} catch {
		return String(cause)
	}
}

/**
 * "One line" is a convention no error's author agreed to: a ClickHouse syntax
 * error arrives with the whole offending statement inlined, and a retry loop
 * writes it once per attempt.
 */
const MAX_CAUSE_CHARS = 500

const cap = (message: string): string =>
	message.length <= MAX_CAUSE_CHARS ? message : `${message.slice(0, MAX_CAUSE_CHARS)}…[truncated]`

/**
 * A bounded, one-line rendering of a cause, safe to hand `Effect.annotateLogs`.
 *
 * `Cause.pretty` is the reflex here and it is the wrong tool for a log line: it
 * renders every reason's stack frames and walks `Error.cause` chains inline, so
 * a `DatabaseError` — whose `cause` is the raw postgres.js error — drags the
 * driver's options into the annotation, and a warehouse failure drags in the
 * statement that failed. Neither told an operator anything the tag and the
 * span's `error.type` did not, and both are billed by the byte.
 *
 * `Cause.prettyErrors` is the same normalizer `Cause.pretty` builds on, stopped
 * one step earlier: it hands back an `Error` per reason with `name` resolved to
 * the tag (`@maple/api/lib/DatabaseError`) and `message` resolved through the
 * same fallbacks — `toString`, then JSON — that make a thrown string, number or
 * bare object legible. Reading only those two leaves the stack and the nested
 * cause behind. The SDK's tracer builds its `exception` events off the same
 * call, so a log line and its span agree on what the failure was called.
 */
export const summarizeCause = (cause: Cause.Cause<unknown>): string => {
	const errors = Cause.prettyErrors(cause)
	if (errors.length === 0) return "empty cause"
	return cap(errors.map((error) => `${error.name}: ${error.message}`).join("; "))
}
