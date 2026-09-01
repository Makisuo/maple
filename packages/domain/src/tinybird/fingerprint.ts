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

import { Option, Schema } from "effect"

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

/**
 * Canonical pattern source for the fingerprint, shared by this module and by
 * the `error_events_mv` SQL in materializations.ts.
 *
 * Written as plain strings rather than regex literals because they have two
 * consumers with different syntax layers: `new RegExp()` here, and a ClickHouse
 * string literal there. The SQL used to carry a hand-copied duplicate of every
 * pattern below, which left the reference implementation and the thing
 * production actually runs free to drift — invisibly, because the tests only
 * ever exercise this file. `chRedactChain` renders the SQL from these same
 * constants, so a change here reaches both or neither.
 *
 * Everything must stay inside the RE2 subset ClickHouse supports: no
 * backreferences, no lookaround. Replacements must contain no `$` (JS) and no
 * backslash (ClickHouse), since both treat those as capture-group syntax.
 */

/** Frames considered for the hash, from the top of the stack down. */
export const MAX_FINGERPRINT_FRAMES = 3
/** How much of StatusMessage is scanned before redaction. */
export const MSG_SCAN_CHARS = 400
/** How much of the redacted result reaches the hash. */
export const MSG_SIGNATURE_CHARS = 120

/**
 * Matches frame lines by SHAPE — one alternative per runtime — rather than by
 * "contains a colon-digit". The old rule (`:\d+|line \d+`) accepted any line
 * with a colon-digit in it, which let two very common NON-frame lines through:
 * Drizzle's `params: <actual row values>` line, and the `Type: message` header
 * (`Code: 62`, `position 1628`, embedded timestamps). Row values and message
 * text then entered the hash, splitting a single bug into thousands of issues.
 *   V8/JVM:          `    at getUser (/app/users.ts:42:18)`
 *   Python:          `  File "/app/main.py", line 42, in get_user`
 *   Ruby:            `    from /app/user.rb:12:in 'find'`
 *   Firefox/Safari:  `getUser@https://app/assets/index.js:42:18`
 *   Go/Rust:         `    /app/main.go:42 +0x1d`
 *   Apple:           `0   My App   0x104a2c1f0   +0x1d0f0`
 *
 * The Apple alternative has no source position to key on, because an iOS crash arrives
 * unsymbolicated — the app's symbols live in a dSYM that never leaves the build machine.
 * It keys on the shape instead: frame index, binary name, hex address. The offset is hex
 * (the SDK renders it that way deliberately) so `FRAME_REDACTIONS` erases it along with
 * the address, leaving `index binaryName +`. That is coarse — grouping by the sequence of
 * binaries rather than of functions — but it is *stable across releases*, which the raw
 * offsets are not: any code change shifts every offset below it and would re-split every
 * issue on every build. When dSYM symbolication lands, function names drop into the same
 * slot.
 *
 * The binary name is matched as `\\S.*`, not as one space-free token: a Mach-O image name
 * is the target's PRODUCT_NAME, and `My App` is an ordinary thing to call an app. Keying
 * on a single token silently excluded every such app from frame matching and left it
 * collapsed on the message hash — the exact failure this alternative exists to fix.
 */
export const FRAME_LINE_PATTERN =
	'^[ \\t]*at |^[ \\t]*File "|^[ \\t]+from [^ ]+:[0-9]+|^[^ \\t@]+@[^ \\t]*:[0-9]+|^[ \\t]+[^ \\t]+\\.(go|rs):[0-9]+|^[0-9]+ +\\S.* +0x[0-9a-fA-F]+'

/** An ordered `[pattern, replacement]` list, applied outermost-first. */
export type Redactions = ReadonlyArray<readonly [pattern: string, replacement: string]>

/**
 * Volatile tokens stripped from a frame line, outermost first. Origin and
 * bundle hash come before the id/number pass: without them every preview host
 * splits an issue, and every deploy rotates Vite's 8-char content hash and
 * re-splits every browser and Worker issue that has already been triaged.
 */
export const FRAME_REDACTIONS: Redactions = [
	["https?://[^/ )]+", ""],
	["-[A-Za-z0-9_-]{8}\\.js", ".js"],
	["-[A-Za-z0-9_-]{8}\\.css", ".css"],
	[":[0-9]+|line [0-9]+|0x[0-9a-fA-F]+|[0-9a-fA-F]{8,}|[0-9]{6,}", ""],
]

/** Redaction for the JSON-object branch of the signature. */
export const JSON_VALUE_REDACTIONS: Redactions = [["[0-9a-fA-F]{8,}|[0-9]+", "#"]]

/**
 * Redaction for the plain-text branch, outermost first.
 *
 * The signature is folded into the hash for EVERY error, not just ones without
 * frames, so anything variable that survives this chain splits one bug into one
 * issue per value. The numeric passes alone were not enough: quoted identifiers
 * (`Table 'checkout_events' doesn't exist`) and query strings are pure runtime
 * values with no digit in them, and each distinct value minted its own issue.
 *
 * A quoted run is redacted only when it is unambiguously a VALUE: it contains a
 * path separator, or it is a single long token. Everything shorter is left
 * alone, because in error text a quoted short word is usually a schema
 * identifier and identifiers are bounded — `insert into "planetscale_events"`
 * and `insert into "anomaly_detector_states"` are two different bugs, and they
 * are exactly the discrimination the always-on signature exists to provide.
 * `reading 'id'` versus `reading 'name'` is the same argument.
 *
 * Both quote styles are treated alike. SQL convention says double quotes are
 * identifiers and single quotes are values, but the messages here are error
 * prose from many runtimes, not SQL, so the convention does not hold.
 *
 * The no-space rule inside each alternative is what keeps prose out: an
 * apostrophe in `doesn't` would otherwise pair with the next quote and swallow
 * the text between them.
 *
 * Route and file paths outside quotes are deliberately KEPT. `Transport error
 * (POST /api/query-engine/service-overview)` names the endpoint that failed,
 * and collapsing every path to a placeholder merges unrelated bugs into one
 * issue. Only the volatile parts of a path go: the origin (so preview hosts
 * don't split an issue), the home directory (so two users' local store paths
 * are one bug), and the query string (pure value).
 *
 * KNOWN RESIDUAL: a short entity slug still splits an issue, whether it is a
 * path segment (`/api/orgs/acme-corp/dashboards/latency-overview`) or a quoted
 * word. Nothing in the string distinguishes an org slug from a route name or a
 * table name, and every rule wide enough to catch `acme-corp` also catches
 * `service-overview` and `planetscale_events`. This is not recoverable with
 * another regex: it needs the emitting SDK to report the parameterized
 * `http.route` rather than the resolved URL. Fix it there.
 *
 * The id pass takes every digit run, not runs of 6+ — under the old threshold a
 * timestamp's two-digit hour survived and split one bug into one issue per hour
 * of the day.
 */
export const MSG_TEXT_REDACTIONS: Redactions = [
	["[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}", "EMAIL"],
	['https?://[^/ )"]+', ""],
	["/(Users|home)/[^/ ]+", "/~"],
	['[?][A-Za-z0-9_]+=[^ )"]*', "?#"],
	["'[^' ]*/[^' ]*'|'[^' ]{25,}'", "'#'"],
	['"[^" ]*/[^" ]*"|"[^" ]{25,}"', '"#"'],
	["`[^` ]*/[^` ]*`|`[^` ]{25,}`", "`#`"],
	["[0-9a-fA-F-]{6,}|[0-9]+", "#"],
]

/**
 * Escape a pattern or replacement for embedding in a ClickHouse single-quoted
 * string literal.
 */
export const chPattern = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`

/**
 * Render a redaction list as the nested `replaceRegexpAll` chain ClickHouse
 * needs. The first entry ends up innermost, so the emitted SQL applies them in
 * the same order `applyRedactions` does.
 */
export const chRedactChain = (expr: string, redactions: Redactions): string =>
	redactions.reduce(
		(inner, [pattern, replacement]) =>
			`replaceRegexpAll(${inner}, ${chPattern(pattern)}, ${chPattern(replacement)})`,
		expr,
	)

/**
 * Apply a redaction list in TypeScript. The replacement is passed as a function
 * so JS never reinterprets `$&` and friends — ClickHouse would not.
 */
const applyRedactions = (value: string, redactions: Redactions): string =>
	redactions.reduce(
		(acc, [pattern, replacement]) => acc.replace(new RegExp(pattern, "g"), () => replacement),
		value,
	)

const FRAME_LINE_RE = new RegExp(FRAME_LINE_PATTERN)

// Display-only candidate keys for the human label (NOT used by the fingerprint).
const LABEL_KEYS = ["title", "message", "error", "_tag", "reason", "name"] as const

/**
 * Parse a JSON object, or return undefined for non-objects (arrays, scalars,
 * malformed). Mirrors the SQL gate `isValidJSON(msg) AND JSONType(msg)='Object'`.
 *
 * Parity caveat: JS `JSON.parse` is stricter than ClickHouse `isValidJSON`;
 * acceptable for the well-formed RFC7807 / serialized-error messages we see.
 */
const decodeJsonObject = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

function tryParseJsonObject(s: string): Record<string, unknown> | undefined {
	// `Schema.Record` rejects arrays and scalars, so the non-object cases the SQL
	// gate excludes decode to `None` alongside the malformed ones.
	return Option.getOrUndefined(decodeJsonObject(s))
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
		.map((key) => `${key}=${applyRedactions(JSON.stringify(obj[key]), JSON_VALUE_REDACTIONS)}`)
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
	return applyRedactions(line, FRAME_REDACTIONS)
}

/** Mirrors the `_msgSig` multiIf: JSON objects take the canonical key signature. */
function messageSignature(statusMessage: string): string {
	const obj = tryParseJsonObject(statusMessage)
	if (obj !== undefined) return jsonSignature(obj)
	return applyRedactions(statusMessage.slice(0, MSG_SCAN_CHARS), MSG_TEXT_REDACTIONS).slice(
		0,
		MSG_SIGNATURE_CHARS,
	)
}

export function computeFingerprintInputs(args: {
	readonly exceptionType: string
	readonly exceptionStacktrace: string
	readonly statusMessage: string
}): FingerprintInputs {
	const rawFrames = args.exceptionStacktrace
		.split("\n")
		.filter((line) => FRAME_LINE_RE.test(line))
		.slice(0, MAX_FINGERPRINT_FRAMES)

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
 * Changing the view does NOT rewrite history: rows already in `error_events`
 * keep their v1 hashes for the rest of their 90-day TTL, so a v2 issue's detail
 * view, occurrence sparkline and sample traces all start empty and fill from
 * cutover forward. That is expected, not a regression — there is no backfill
 * short of replaying the raw traces.
 *
 * v1 → v2 (this change): frame lines are matched by shape rather than by
 * "contains a colon-digit", and the message signature is always folded in and
 * additionally strips quoted values and query strings.
 *
 * **Adding the Apple frame alternative deliberately did NOT bump this**, even
 * though it rotates hashes for iOS crashes that are still occurring, which is
 * what the rule above otherwise calls for. The retirement this version drives is
 * version-keyed, not hash-keyed: `ErrorsService` archives every `kind: "error"`
 * issue whose `fingerprintVersion` is below this constant, on the premise stated
 * in `error_issues.fingerprintVersion` that a row on an older version can never
 * receive another occurrence. That premise holds only when a bump rotates
 * *every* hash. The Apple change rotates iOS hashes alone, so a bump would
 * archive every Node, Python, Go and browser issue in every org — and nothing
 * un-archives them, because the tick's upsert conflicts on
 * `(orgId, fingerprintHash)` and never clears `archivedAt`.
 *
 * The cost of not bumping is small and bounded: the collapsed iOS issues stop
 * receiving occurrences the moment their hash changes, and retire through the
 * ordinary resolved window instead of on sight. Teaching the sweep to retire by
 * hash rather than by version is what would let a partial-rotation change bump
 * this safely.
 */
export const FINGERPRINT_VERSION = 2
