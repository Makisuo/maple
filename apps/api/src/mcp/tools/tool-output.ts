/**
 * Bounding what a tool hands back to the model — once, at the moment the result is produced.
 *
 * ## Why here and not in the loop
 *
 * `chat/loop/context.ts` used to be the only bound: it walked the transcript mid-turn and rewrote
 * old tool results in place. That works on token count and fails on everything else.
 *
 * The default chat route is OpenRouter (`z-ai/glm-5.3-flash:nitro`), whose route id is `"openrouter-chat"`
 * — not in `@opencode-ai/ai`'s `RESPECTS_INLINE_HINTS` (`anthropic-messages`, `bedrock-converse`), so
 * `applyCachePolicy` returns early and Maple emits no cache breakpoints at all. Caching on that path
 * is *implicit prefix* caching: the provider matches the longest identical prefix it has seen, and
 * there is no breakpoint to place. Prefix stability is the only lever there is.
 *
 * A retroactive rewrite is the one thing that lever cannot survive. It edits results from early
 * steps, so the divergence lands near the front of the turn and everything after it stops matching —
 * and it fires precisely when the transcript is longest, which is when the cached prefix is worth
 * the most.
 *
 * So the transcript is append-only instead: a result is bounded when it is created, and the text the
 * model saw on step 3 is byte-identical on step 9. `chat/loop/context.ts` keeps a fallback for the
 * case where even bounded results overflow, but it now drops whole steps rather than rewriting them,
 * and it should almost never run.
 *
 * ## The limits
 *
 * Dual, first hit wins — lines *and* bytes, because Maple's tools fail in both directions: a
 * warehouse query returns tens of thousands of short rows, a trace payload returns a handful of
 * enormous ones. Either alone lets the other through.
 */

/** Line ceiling. Enough rows to see a distribution; far short of enough to reason over one by one. */
export const MAX_TOOL_OUTPUT_LINES = 2_000

/** Byte ceiling — UTF-8 bytes, not JS string length, because that is what the wire and the tokenizer see. */
export const MAX_TOOL_OUTPUT_BYTES = 50 * 1024

export interface TruncateToolOutputOptions {
	readonly maxLines?: number
	readonly maxBytes?: number
}

export interface TruncatedToolOutput {
	readonly text: string
	readonly truncated: boolean
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const utf8ByteLength = (text: string): number => encoder.encode(text).length

/** `512B`, `50.0KB`, `1.2MB`. */
export const formatSize = (bytes: number): string => {
	if (bytes < 1024) return `${bytes}B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/**
 * Lines in `text`, counting the way a file does: empty text has none, and a trailing newline
 * *terminates* the last line rather than opening an empty one.
 */
export const countLines = (text: string): number => {
	if (text.length === 0) return 0
	let lines = 1
	for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines++
	return text.endsWith("\n") ? lines - 1 : lines
}

/** Keep the first `maxLines` lines, dropping the newline that would have terminated the last one. */
const sliceToLines = (text: string, maxLines: number): string => {
	if (maxLines <= 0) return ""
	let cut = -1
	for (let i = 0; i < maxLines; i++) {
		const next = text.indexOf("\n", cut + 1)
		// Fewer lines than the cap — nothing to cut.
		if (next === -1) return text
		cut = next
	}
	return text.slice(0, cut)
}

/**
 * Keep the first `maxBytes` UTF-8 bytes without splitting a character.
 *
 * Continuation bytes are `0b10xxxxxx`; if the first excluded byte is one, the cut landed inside a
 * multi-byte sequence, so walk back to the sequence's start. Without this an emoji or a CJK
 * identifier at the boundary decodes to U+FFFD, which is a corrupted value the model cannot tell
 * apart from one the tool actually returned.
 */
const sliceToBytes = (text: string, maxBytes: number): string => {
	if (maxBytes <= 0) return ""
	const bytes = encoder.encode(text)
	if (bytes.length <= maxBytes) return text
	let end = maxBytes
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
	return decoder.decode(bytes.subarray(0, end))
}

/**
 * What the model is told in place of the dropped tail.
 *
 * It names both totals and says what to do about it. A tool result that quietly loses its tail is
 * indistinguishable from a tool that returned less than it did — and Maple's tools all take filters,
 * so "ask a narrower question" is a real instruction rather than an apology.
 */
const marker = (keptLines: number, totalLines: number, keptBytes: number, totalBytes: number): string =>
	`\n\n…[truncated: showing the first ${keptLines} of ${totalLines} lines ` +
	`(${formatSize(keptBytes)} of ${formatSize(totalBytes)}). ` +
	`Narrow the request — add filters, shorten the time range, or lower the limit — to see the rest.]`

/**
 * Bound one tool result. Returns the text unchanged when it already fits, so callers can apply this
 * unconditionally and a small result pays nothing but the measurement.
 */
export const truncateToolOutput = (
	text: string,
	options: TruncateToolOutputOptions = {},
): TruncatedToolOutput => {
	const maxLines = options.maxLines ?? MAX_TOOL_OUTPUT_LINES
	const maxBytes = options.maxBytes ?? MAX_TOOL_OUTPUT_BYTES

	const totalLines = countLines(text)
	// Measured, not inferred from `text.length`. A UTF-8 character is never *fewer* than one byte but
	// is often more, so `length <= maxBytes` proves nothing: 400 "…" characters are 400 by `length`
	// and 1200 on the wire.
	const totalBytes = utf8ByteLength(text)
	if (totalLines <= maxLines && totalBytes <= maxBytes) return { text, truncated: false }

	const byLines = totalLines > maxLines ? sliceToLines(text, maxLines) : text
	const kept = sliceToBytes(byLines, maxBytes)

	return {
		text: kept + marker(countLines(kept), totalLines, utf8ByteLength(kept), totalBytes),
		truncated: true,
	}
}
