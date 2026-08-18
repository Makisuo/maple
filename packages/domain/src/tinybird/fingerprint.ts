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
	 * Normalized StatusMessage, folded into the hash whenever there are no
	 * frame-shaped stack lines (regardless of whether ExceptionType is present).
	 * For a JSON object this is a general, key-name-agnostic canonical signature
	 * (sorted `key=redactedValue` pairs over ALL top-level keys); otherwise the
	 * redacted message prefix. Prevents status-only errors — and errors with
	 * generic or malformed ExceptionType values — from collapsing into one issue.
	 */
	readonly msgFallback: string
	/**
	 * Value-aware human display label (mirrors the `ErrorLabel` column). Display
	 * only and decoupled from the fingerprint — many labels may map to one hash,
	 * so the key heuristic here never affects bucketing.
	 */
	readonly label: string
}

// Matches frame-shaped lines across common runtimes:
//   JS/Java/Go/Ruby: `file.ext:123` style
//   Python:          `File "path", line 123, in function`
const FRAME_LINE_RE = /:\d+|line \d+/
// Volatile tokens stripped from a frame line. The last two alternatives mirror
// MSG_REDACT_RE: trace/span/request ids embedded in a stack line would otherwise
// split one bug into one issue per occurrence.
const LINE_NUM_OR_HEX_RE = /:\d+|line \d+|0x[0-9a-fA-F]+|[0-9a-fA-F]{8,}|[0-9]{6,}/g
const MSG_REDACT_RE = /[0-9a-fA-F]{8,}|[0-9]+/g

// Display-only candidate keys for the human label (NOT used by the fingerprint).
const LABEL_KEYS = ["title", "message", "error", "_tag", "reason", "name"] as const

/**
 * Parse a JSON object, or return undefined for non-objects (arrays, scalars,
 * malformed). Mirrors the SQL gate `isValidJSON(msg) AND JSONType(msg)='Object'`.
 *
 * Parity caveat: JS `JSON.parse` is stricter than ClickHouse `isValidJSON`;
 * acceptable for the well-formed RFC7807 / serialized-error messages we see.
 */
function tryParseJsonObject(s: string): Record<string, unknown> | undefined {
	try {
		const v = JSON.parse(s) as unknown
		return v !== null && typeof v === "object" && !Array.isArray(v)
			? (v as Record<string, unknown>)
			: undefined
	} catch {
		return undefined
	}
}

/**
 * General, key-name-agnostic canonical signature: for every top-level key, emit
 * `key=redactedRawValue`, then sort and join. Mirrors the SQL
 * `arrayStringConcat(arraySort(arrayMap(... JSONExtractKeysAndValuesRaw ...)), '|')`.
 * `JSON.stringify(value)` reproduces the raw token (strings quoted, numbers bare),
 * matching `JSONExtractKeysAndValuesRaw` for scalars. Nested objects/arrays are
 * hashed as their (compact) raw form — only top-level order is canonicalized.
 */
function jsonSignature(obj: Record<string, unknown>): string {
	return Object.keys(obj)
		.map((key) => `${key}=${JSON.stringify(obj[key]).replace(MSG_REDACT_RE, "#")}`)
		.sort()
		.join("|")
}

/** Mirrors the `_statusLabel` SQL multiIf (display-only). */
function statusLabel(statusMessage: string): string {
	if (statusMessage === "") return "Unknown Error"

	// Effect ParseError — not valid JSON; label by the first field. Must precede
	// the JSON branch (these start with "{" but aren't JSON objects).
	if (statusMessage.startsWith("{ readonly") || statusMessage.includes("└─")) {
		const m = statusMessage.match(/readonly (\w+)/)
		return m ? `Schema parse error: ${m[1]}` : "Schema parse error"
	}

	const obj = tryParseJsonObject(statusMessage)
	if (obj !== undefined || statusMessage.startsWith("[")) {
		if (obj !== undefined) {
			for (const key of LABEL_KEYS) {
				const v = obj[key]
				if (typeof v === "string" && v !== "") return v
			}
			const type = obj.type
			if (typeof type === "string" && type !== "") return type.replace(/^.*\//, "")
		}
		return "JSON error"
	}

	// Legacy "ErrorClass: message" / "message (detail)" cut — first matching
	// delimiter (in this order), else first 150 chars. Mirrors the SQL multiIf.
	const colon = statusMessage.indexOf(": ")
	if (colon > 2) return statusMessage.slice(0, colon)
	const paren = statusMessage.indexOf(" (")
	if (paren > 2) return statusMessage.slice(0, paren)
	const newline = statusMessage.indexOf("\n")
	if (newline > 2) return statusMessage.slice(0, newline)
	return statusMessage.slice(0, Math.min(statusMessage.length, 150))
}

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

	let msgFallback = ""
	if (fpFrames === "") {
		const obj = tryParseJsonObject(args.statusMessage)
		msgFallback = obj ? jsonSignature(obj) : args.statusMessage.slice(0, 200).replace(MSG_REDACT_RE, "#")
	}

	const label = args.exceptionType !== "" ? args.exceptionType : statusLabel(args.statusMessage)

	return { topFrame, fpFrames, msgFallback, label }
}
