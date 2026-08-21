import { describe, expect, it } from "vitest"
import { isChunkLoadError } from "./chunk-reload"

describe("isChunkLoadError", () => {
	it("matches a failed dynamic import", () => {
		expect(isChunkLoadError(new Error("Failed to fetch dynamically imported module: /assets/x.js"))).toBe(
			true,
		)
	})

	it("matches a stale route table on a superseded build (Chrome and Safari wording)", () => {
		expect(
			isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'component')")),
		).toBe(true)
		expect(
			isChunkLoadError(
				new TypeError("undefined is not an object (evaluating 'route.options.component')"),
			),
		).toBe(true)
	})

	it("leaves ordinary TypeErrors to the error boundary", () => {
		expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(
			false,
		)
		expect(isChunkLoadError("boom")).toBe(false)
	})
})
