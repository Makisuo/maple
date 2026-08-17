import { describe, expect, it } from "vitest"
import { parseUserAgent } from "./user-agent"

describe("parseUserAgent", () => {
	it("identifies common browsers and OSes", () => {
		const chromeMac = parseUserAgent(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
		)
		expect(chromeMac.browserName).toBe("Chrome")
		expect(chromeMac.osName).toBe("macOS")
		expect(chromeMac.deviceType).toBe("desktop")
	})

	it("classifies mobile Chrome on Android", () => {
		const android = parseUserAgent(
			"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
		)
		expect(android.browserName).toBe("Chrome")
		expect(android.osName).toBe("Android")
		expect(android.deviceType).toBe("mobile")
	})

	it("classifies iPhone Safari as iOS despite 'like Mac OS X'", () => {
		const iphone = parseUserAgent(
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
		)
		expect(iphone.browserName).toBe("Safari")
		expect(iphone.osName).toBe("iOS")
		expect(iphone.deviceType).toBe("mobile")
	})

	it("falls back to Unknown/desktop for unrecognized agents", () => {
		const odd = parseUserAgent("SomeBot/1.0")
		expect(odd.browserName).toBe("Unknown")
		expect(odd.osName).toBe("Unknown")
		expect(odd.deviceType).toBe("desktop")
	})
})
