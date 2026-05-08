/**
 * Sanitizers for sinks that hold user-controlled strings — CSS values, HTML
 * hrefs, inline-script JSON, and post-login redirect targets. Each helper
 * fails closed: the caller decides what to do with a `null` (drop the entry,
 * fall back, etc.) rather than ever rendering an unvetted string.
 */

const CSS_COLOR_RE =
	/^(?:#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\([^()]*\)|hsla?\([^()]*\)|var\(--[a-z0-9_-]+(?:,[^()]*)?\)|currentColor|transparent|inherit|initial|unset|[a-z]+)$/i

const ALLOWED_HREF_SCHEMES = new Set(["http:", "https:", "mailto:"])

const LINE_SEPARATOR = " "
const PARAGRAPH_SEPARATOR = " "

/**
 * CSS.escape an identifier the way browsers do, so a value like
 * `</style><script>alert(1)</script>` cannot break out of the surrounding
 * `--color-…` declaration.
 */
export const sanitizeCssIdentifier = (key: string): string => {
	if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
		return CSS.escape(key)
	}
	// Fallback for environments without CSS.escape: hex-encode anything
	// that isn't [a-zA-Z0-9_-].
	return key.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch.charCodeAt(0).toString(16)} `)
}

/**
 * Returns `value` only if it parses as a known-safe CSS color expression.
 * Drops anything containing CSS structural tokens like `;`, `}`, `<` etc.
 */
export const validateCssColor = (value: string | undefined | null): string | null => {
	if (typeof value !== "string") return null
	const trimmed = value.trim()
	if (trimmed.length === 0) return null
	if (/[<>;{}]/.test(trimmed)) return null
	return CSS_COLOR_RE.test(trimmed) ? trimmed : null
}

/**
 * Allow http(s) and mailto absolute URLs, plus same-origin relative paths
 * (single leading `/`). Reject `javascript:`, `data:`, `vbscript:`,
 * protocol-relative (`//`), and anything malformed.
 */
export const validateUrlScheme = (raw: string | undefined | null): string | null => {
	if (typeof raw !== "string") return null
	const trimmed = raw.trim()
	if (trimmed.length === 0) return null
	if (trimmed.startsWith("//")) return null
	if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed
	try {
		const parsed = new URL(trimmed)
		return ALLOWED_HREF_SCHEMES.has(parsed.protocol) ? trimmed : null
	} catch {
		return null
	}
}

/**
 * Escape a JSON-stringified value before embedding it inside an inline
 * `<script>...</script>` block. JSON.stringify alone does not escape `<`
 * or `>`, so a string like `</script><script>alert(1)</script>` would
 * close the script tag verbatim. U+2028/U+2029 are valid line terminators
 * in JS but unescaped in JSON, so they must also be encoded.
 */
export const escapeJsonInHtml = (json: string): string =>
	json
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026")
		.split(LINE_SEPARATOR)
		.join("\\u2028")
		.split(PARAGRAPH_SEPARATOR)
		.join("\\u2029")

/**
 * Validate a post-login `redirect_url` query value. Allows same-origin
 * relative paths (single leading `/`, no `//`). Returns null for absolute
 * URLs, scheme tricks, or empty input — caller should fall back to `/`.
 */
export const validateInternalRedirect = (raw: string | undefined | null): string | null => {
	if (typeof raw !== "string") return null
	const trimmed = raw.trim()
	if (trimmed.length === 0) return null
	if (!trimmed.startsWith("/")) return null
	if (trimmed.startsWith("//")) return null
	if (trimmed.startsWith("/\\")) return null
	return trimmed
}
