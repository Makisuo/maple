/**
 * Bounding tool output at creation.
 *
 * The properties that matter: both limits bite, the text stays valid UTF-8 across the cut, the model
 * is told what it lost, and output that already fits is returned untouched — because every result on
 * every tool call goes through here.
 */
import { assert, describe, it } from "vitest"
import {
	countLines,
	formatSize,
	MAX_TOOL_OUTPUT_BYTES,
	MAX_TOOL_OUTPUT_LINES,
	truncateToolOutput,
	utf8ByteLength,
} from "./tool-output"

describe("countLines", () => {
	it("counts the way a file does", () => {
		assert.equal(countLines(""), 0)
		assert.equal(countLines("a"), 1)
		// A trailing newline terminates the last line rather than opening an empty one.
		assert.equal(countLines("a\n"), 1)
		assert.equal(countLines("a\nb"), 2)
		assert.equal(countLines("a\nb\n"), 2)
		assert.equal(countLines("\n"), 1)
	})
})

describe("formatSize", () => {
	it("scales the unit", () => {
		assert.equal(formatSize(512), "512B")
		assert.equal(formatSize(51_200), "50.0KB")
		assert.equal(formatSize(1_258_291), "1.2MB")
	})
})

describe("truncateToolOutput", () => {
	it("returns short output untouched", () => {
		const text = "3 traces found\nab12\ncd34"
		const result = truncateToolOutput(text)
		assert.isFalse(result.truncated)
		// Identity: every tool call pays this, so the common case must cost nothing but measurement.
		assert.strictEqual(result.text, text)
	})

	it("cuts on the line limit", () => {
		const text = Array.from({ length: MAX_TOOL_OUTPUT_LINES + 500 }, (_, i) => `row ${i}`).join("\n")
		const result = truncateToolOutput(text)

		assert.isTrue(result.truncated)
		const body = result.text.slice(0, result.text.indexOf("\n\n…["))
		assert.equal(countLines(body), MAX_TOOL_OUTPUT_LINES)
		assert.isTrue(body.startsWith("row 0\n"))
		assert.isTrue(body.endsWith(`row ${MAX_TOOL_OUTPUT_LINES - 1}`))
	})

	it("cuts on the byte limit even when the line count is fine", () => {
		// One enormous line — a trace payload, not a row set. The line limit alone would pass it.
		const result = truncateToolOutput("x".repeat(MAX_TOOL_OUTPUT_BYTES * 2))

		assert.isTrue(result.truncated)
		const body = result.text.slice(0, result.text.indexOf("\n\n…["))
		assert.equal(utf8ByteLength(body), MAX_TOOL_OUTPUT_BYTES)
	})

	it("counts bytes, not JS string length", () => {
		// "…" is 3 UTF-8 bytes. 400 of them is 1200 bytes against a 1000-byte budget, but only 400
		// by `.length` — measuring the wrong one lets 20% more through than the provider will see.
		const result = truncateToolOutput("…".repeat(400), { maxBytes: 1_000, maxLines: 10 })
		assert.isTrue(result.truncated)
	})

	it("never splits a character", () => {
		// A budget landing mid-sequence: 3-byte characters against a budget that is not a multiple
		// of 3. A naive byte slice decodes the tail to U+FFFD, which the model cannot tell apart
		// from a replacement character the tool really returned.
		for (const maxBytes of [100, 101, 102]) {
			const result = truncateToolOutput("…".repeat(200), { maxBytes, maxLines: 10 })
			const body = result.text.slice(0, result.text.indexOf("\n\n…["))
			assert.notInclude(body, "�")
			assert.isAtMost(utf8ByteLength(body), maxBytes)
		}
	})

	it("keeps the head, so the excerpt is the start of the real output", () => {
		const text = `first row\n${"filler\n".repeat(5_000)}last row`
		assert.isTrue(truncateToolOutput(text).text.startsWith("first row\n"))
	})

	it("tells the model what it lost and what to do about it", () => {
		// A result that quietly loses its tail is indistinguishable from a tool that returned less
		// than it did — which is how a model concludes "there were only 2000 traces".
		const text = Array.from({ length: 10_000 }, (_, i) => `row ${i}`).join("\n")
		const marker = truncateToolOutput(text).text

		assert.include(marker, "truncated")
		assert.include(marker, `first ${MAX_TOOL_OUTPUT_LINES} of 10000 lines`)
		assert.include(marker, "Narrow the request")
	})

	it("handles empty output", () => {
		const result = truncateToolOutput("")
		assert.isFalse(result.truncated)
		assert.equal(result.text, "")
	})

	it("bounds a single line longer than the byte budget", () => {
		// No newline to cut at — the line slice is a no-op and the byte slice has to carry it.
		const result = truncateToolOutput("y".repeat(5_000), { maxLines: 10, maxBytes: 1_000 })
		const body = result.text.slice(0, result.text.indexOf("\n\n…["))
		assert.equal(body.length, 1_000)
	})
})
