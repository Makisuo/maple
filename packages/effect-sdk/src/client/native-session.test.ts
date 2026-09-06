import { getActiveSink, getSessionId } from "@maple/browser-session"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { startClientSession } from "./replay-loader.js"
import { setupStandaloneSession } from "./standalone-session.js"

const config = {
	serviceName: "native-test",
	endpoint: "https://collector.test",
	ingestKey: "test-key",
}

describe("browser sessions in React Native", () => {
	beforeEach(() => {
		// React Native exposes window without a DOM or browser Web Crypto.
		vi.stubGlobal("window", {})
		vi.stubGlobal("document", undefined)
		vi.stubGlobal("crypto", undefined)
		vi.stubGlobal("fetch", vi.fn())
	})

	afterEach(() => vi.unstubAllGlobals())

	it("skips browser capture at client startup", async () => {
		const session = startClientSession(config)
		await session.stop()
		expect(getActiveSink()).toBeUndefined()
		expect(fetch).not.toHaveBeenCalled()
	})

	it("skips standalone browser metadata", () => {
		expect(setupStandaloneSession(config)).toBeUndefined()
		expect(fetch).not.toHaveBeenCalled()
	})

	it("does not mint a browser session when a later span requests its id", () => {
		expect(getSessionId()).toBeUndefined()
	})
})
