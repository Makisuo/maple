/**
 * Reference TS implementation of the error fingerprint normalization logic
 * that lives in the `error_events_mv` materialized view (materializations.ts).
 *
 * The SQL in ClickHouse is authoritative at runtime; this module exists so the
 * algorithm can be tested with representative stack traces from Node, Python,
 * Java, and Go without spinning up ClickHouse. If you change one, change both.
 *
 * The hash itself (cityHash64) is applied in ClickHouse and not reproduced here —
 * tests assert on the *inputs* to the hash, which is what actually determines
 * grouping quality.
 */

export interface FingerprintInputs {
	/** First normalized frame — stored on error_events and error_issues for display. */
	readonly topFrame: string
	/** Top 3 normalized frames joined by newline — the stack portion of the hash. */
	readonly fpFrames: string
	/**
	 * Normalized StatusMessage prefix, folded into the hash whenever there are no
	 * frame-shaped stack lines (regardless of whether ExceptionType is present).
	 * Prevents status-only errors — and errors with generic or malformed
	 * ExceptionType values — from all collapsing into a single issue per service.
	 */
	readonly msgFallback: string
}

// Matches frame-shaped lines across common runtimes:
//   JS/Java/Go/Ruby: `file.ext:123` style
//   Python:          `File "path", line 123, in function`
const FRAME_LINE_RE = /:\d+|line \d+/
const LINE_NUM_OR_HEX_RE = /:\d+|line \d+|0x[0-9a-fA-F]+/g
const MSG_REDACT_RE = /[0-9a-fA-F]{8,}|[0-9]+/g

export function computeFingerprintInputs(args: {
	readonly exceptionType: string
	readonly exceptionStacktrace: string
	readonly statusMessage: string
}): FingerprintInputs {
	const rawFrames = args.exceptionStacktrace
		.split("\n")
		.filter((line) => FRAME_LINE_RE.test(line))
		.slice(0, 3)

	const topFrames = rawFrames.map((line) => line.replace(LINE_NUM_OR_HEX_RE, ""))
	const topFrame = topFrames[0] ?? ""
	const fpFrames = topFrames.join("\n")

	const msgFallback = fpFrames === "" ? args.statusMessage.slice(0, 200).replace(MSG_REDACT_RE, "#") : ""

	return { topFrame, fpFrames, msgFallback }
}
