/**
 * Shape detection + tokenizing for the text inside the error banner.
 *
 * Error messages arrive as one of three things in practice: a JSON blob (an
 * upstream API echoing its error envelope), a stack trace, or a plain sentence.
 * The banner used to render all three as one undifferentiated monospace wall,
 * which is exactly when a 400-character JSON payload reads as noise. Detect the
 * shape here — pure, testable, no React — and let the component paint it.
 */

import { Option } from "effect"

import { trySync } from "./try-sync"

export type ErrorBodyFormat = "json" | "text"

export interface ErrorBody {
	format: ErrorBodyFormat
	/** The text both states render — pretty-printed when JSON. Collapsing is a
	 * height clamp on the same painted body, never a second, plainer rendition. */
	full: string
}

/** Cheap pre-check so we don't hand every plain sentence to `JSON.parse`. */
function looksLikeJson(text: string): boolean {
	const first = text[0]
	const last = text[text.length - 1]
	return (first === "{" && last === "}") || (first === "[" && last === "]")
}

export function parseErrorBody(message: string): ErrorBody {
	const trimmed = message.trim()

	if (looksLikeJson(trimmed)) {
		// The delimiter check already guarantees an object or an array — the JSON
		// grammar admits nothing else between those braces — so a parse that
		// succeeds is a parse worth pretty-printing. A truncated or otherwise
		// malformed body decodes to `None` and falls through to text.
		const parsed = trySync<unknown>(() => JSON.parse(trimmed))
		if (Option.isSome(parsed)) {
			return { format: "json", full: JSON.stringify(parsed.value, null, 2) }
		}
	}

	return { format: "text", full: message }
}

export type JsonTokenType = "key" | "string" | "number" | "keyword" | "punctuation" | "plain"

export interface JsonToken {
	text: string
	type: JsonTokenType
}

/**
 * Colors resolve to the app's Sugar High palette where one exists (web) and
 * fall back to the severity tokens every Maple surface ships (local-ui), so the
 * banner never has to know which app is rendering it.
 */
export const JSON_TOKEN_COLOR: Record<JsonTokenType, string> = {
	key: "var(--sh-property, var(--color-severity-debug))",
	keyword: "var(--sh-keyword, var(--color-severity-warn))",
	number: "var(--sh-class, var(--color-severity-warn))",
	plain: "currentColor",
	punctuation: "var(--sh-sign, currentColor)",
	string: "var(--sh-string, var(--color-severity-info))",
} satisfies Record<JsonTokenType, string>

const JSON_TOKEN_RE =
	/(\s+)|("(?:\\.|[^"\\])*"(?=\s*:))|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])|([^\s{}[\],:"]+|.)/gy

/**
 * Tokenizer for the output of `JSON.stringify` — not a general JSON parser. The
 * input is always something we just serialized ourselves, so the grammar is
 * known-good and a sticky regex is enough. Adjacent same-type tokens merge to
 * keep the span count down on large payloads.
 */
export function tokenizeJson(source: string): JsonToken[] {
	const tokens: JsonToken[] = []

	const push = (text: string, type: JsonTokenType) => {
		const last = tokens[tokens.length - 1]
		if (last && last.type === type) last.text += text
		else tokens.push({ text, type })
	}

	JSON_TOKEN_RE.lastIndex = 0
	let match = JSON_TOKEN_RE.exec(source)
	while (match !== null) {
		const [text, whitespace, key, string, number, keyword, punctuation] = match
		if (whitespace !== undefined) push(text, "punctuation")
		else if (key !== undefined) push(text, "key")
		else if (string !== undefined) push(text, "string")
		else if (number !== undefined) push(text, "number")
		else if (keyword !== undefined) push(text, "keyword")
		else if (punctuation !== undefined) push(text, "punctuation")
		else push(text, "plain")
		match = JSON_TOKEN_RE.exec(source)
	}

	return tokens
}

export interface ErrorTextLine {
	text: string
	/** A stack frame — rendered dimmer so the message itself stays the subject. */
	frame: boolean
}

const FRAME_RE = /^\s*(at\s|from\s|File\s"|\.{3}\s|Caused by:|\w+\.\w+\(.*\))/

/** Splits a plain-text error into its message and its (dimmed) stack frames. */
export function splitErrorText(message: string): ErrorTextLine[] {
	return message.split("\n").map((text, index) => ({ frame: index > 0 && FRAME_RE.test(text), text }))
}
