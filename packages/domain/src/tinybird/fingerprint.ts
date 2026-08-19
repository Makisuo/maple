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
	 * Redacted StatusMessage signature, folded into the hash ALWAYS — not only
	 * when frames are absent. For a JSON object this is a general,
	 * key-name-agnostic canonical signature (sorted `key=redactedValue` pairs over
	 * ALL top-level keys); otherwise the redacted message prefix.
	 *
	 * Always-on because frames alone cannot separate two bugs in a bundled
	 * runtime: a Worker minifies every module into `worker.js`, so 25 distinct
	 * DatabaseError bugs shared one set of top frames and collapsed into a single
	 * issue. It cannot reinflate cardinality the way a raw prefix would, because
	 * everything variable is redacted before it reaches the hash.
	 */
	readonly msgSignature: string
	/**
	 * Value-aware human display label (mirrors the `ErrorLabel` column). Display
	 * only and decoupled from the fingerprint — many labels may map to one hash,
	 * so the key heuristic here never affects bucketing.
	 */
	readonly label: string
}

// Matches frame lines by SHAPE — one alternative per runtime — rather than by
// "contains a colon-digit". The old rule (`/:\d+|line \d+/`) accepted any line
// with a colon-digit in it, which let two very common NON-frame lines through:
// Drizzle's `params: <actual row values>` line, and the `Type: message` header
// (`Code: 62`, `position 1628`, embedded timestamps). Row values and message text
// then entered the hash, splitting a single bug into thousands of issues.
//   V8/JVM:          `    at getUser (/app/users.ts:42:18)`
//   Python:          `  File "/app/main.py", line 42, in get_user`
//   Ruby:            `    from /app/user.rb:12:in 'find'`
//   Firefox/Safari:  `getUser@https://app/assets/index.js:42:18`
//   Go/Rust:         `    /app/main.go:42 +0x1d`
const FRAME_LINE_RE =
	/^[ \t]*at |^[ \t]*File "|^[ \t]+from [^ ]+:\d+|^[^ \t@]+@[^ \t]*:\d+|^[ \t]+[^ \t]+\.(?:go|rs):\d+/
// Volatile tokens stripped from a frame line, outermost first. Origin and bundle
// hash come before the id/number pass: without them every preview host splits an
// issue, and every deploy rotates Vite's 8-char content hash and re-splits every
// browser and Worker issue that has already been triaged.
const FRAME_ORIGIN_RE = /https?:\/\/[^/ )]+/g
const FRAME_BUNDLE_JS_RE = /-[A-Za-z0-9_-]{8}\.js/g
const FRAME_BUNDLE_CSS_RE = /-[A-Za-z0-9_-]{8}\.css/g
const LINE_NUM_OR_HEX_RE = /:\d+|line \d+|0x[0-9a-fA-F]+|[0-9a-fA-F]{8,}|[0-9]{6,}/g
// Redaction for the JSON-object branch of the signature (unchanged).
const MSG_REDACT_RE = /[0-9a-fA-F]{8,}|[0-9]+/g
// Redaction for the plain-text branch, in order: emails, then the URL origin,
// then the user's home directory, then ids and numbers.
//
// Route and file paths are deliberately KEPT. `Transport error (POST
// /api/query-engine/service-overview)` names the endpoint that failed, and
// collapsing every path to a placeholder merges unrelated bugs into one issue.
// Only the volatile parts of a path are redacted: the origin (so preview hosts
// don't split an issue) and the home directory (so `/Users/riordan/...` and
// `/Users/juanbermudez/...` are one bug, not two).
//
// The id pass takes every digit run, not runs of 6+ — under the old threshold a
// timestamp's two-digit hour survived and split one bug into one issue per hour
// of the day.
const MSG_EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const MSG_URL_ORIGIN_RE = /https?:\/\/[^/ )"]+/g
const MSG_HOME_RE = /\/(?:Users|home)\/[^/ ]+/g
const MSG_ID_RE = /[0-9a-fA-F-]{6,}|[0-9]+/g

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

/** Mirrors the nested `replaceRegexpAll` chain applied to each frame line. */
function normalizeFrame(line: string): string {
	return line
		.replace(FRAME_ORIGIN_RE, "")
		.replace(FRAME_BUNDLE_JS_RE, ".js")
		.replace(FRAME_BUNDLE_CSS_RE, ".css")
		.replace(LINE_NUM_OR_HEX_RE, "")
}

/** Mirrors the `_msgSig` multiIf: JSON objects take the canonical key signature. */
function messageSignature(statusMessage: string): string {
	const obj = tryParseJsonObject(statusMessage)
	if (obj !== undefined) return jsonSignature(obj)
	return statusMessage
		.slice(0, 400)
		.replace(MSG_EMAIL_RE, "EMAIL")
		.replace(MSG_URL_ORIGIN_RE, "")
		.replace(MSG_HOME_RE, "/~")
		.replace(MSG_ID_RE, "#")
		.slice(0, 120)
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

	const topFrames = rawFrames.map(normalizeFrame)
	const topFrame = topFrames[0] ?? ""
	const fpFrames = topFrames.join("\n")

	const msgSignature = messageSignature(args.statusMessage)

	const label = args.exceptionType !== "" ? args.exceptionType : statusLabel(args.statusMessage)

	return { topFrame, fpFrames, msgSignature, label }
}

/**
 * Version of the fingerprint algorithm above.
 *
 * Bumped whenever a change to frame matching, normalization, or the message
 * signature rotates hashes for errors that are still occurring. The evaluator
 * stamps it on every issue it writes, and retention archives issues carrying an
 * older version: after a bump the live bugs each get one clean issue and the
 * stale rows retire deterministically, instead of sitting in `triage` until the
 * 14-day auto-resolve window catches up.
 *
 * Deliberately NOT a ClickHouse column. Old and new hashes cannot collide, so
 * the warehouse needs no discriminator — only the Postgres row does, and keeping
 * it there means a future bump is a constant change plus a sweep, with no
 * datasource migration or materialized-view backfill.
 *
 * v1 → v2 (this change): frame lines are matched by shape rather than by
 * "contains a colon-digit", and the message signature is always folded in.
 */
export const FINGERPRINT_VERSION = 2
