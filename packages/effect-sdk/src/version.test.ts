import { describe, expect, it } from "vitest"
import pkg from "../package.json" with { type: "json" }
import { SDK_VERSION } from "./version.js"

describe("SDK_VERSION", () => {
	it("matches package.json — bump both or neither", () => {
		expect(SDK_VERSION).toBe(pkg.version)
	})
})
