import { describe, expect, it } from "vitest"
import { isLikelyBot, parseUserAgent } from "./user-agent"

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

describe("isLikelyBot", () => {
	// Every one of these was observed uploading corrupt replay chunks in
	// production; they are the reason the gate exists.
	it.each([
		"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
		"Mozilla/5.0 (compatible; YandexRenderResourcesBot/1.0; +http://yandex.com/bots) AppleWebKit/537.36",
		"Mozilla/5.0 (compatible; Baiduspider-render/2.0; +http://www.baidu.com/search/spider.html)",
		"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
		"Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0.0.0 Safari/537.36",
	])("classifies %s as a bot", (ua) => {
		expect(isLikelyBot(ua)).toBe(true)
	})

	// A false positive silently stops recording a paying customer's real user,
	// which is worse than missing a crawler — CUBOT is the case that bites.
	it.each([
		"Mozilla/5.0 (Linux; Android 10; CUBOT NOTE 20) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
	])("does not classify %s as a bot", (ua) => {
		expect(isLikelyBot(ua)).toBe(false)
	})
})
