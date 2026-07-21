import { describe, expect, it } from "vitest"
import { localApiBaseForLocation, localOtlpEndpointForLocation } from "./constants"

const location = (value: string): URL => new URL(value)

describe("local UI endpoint selection", () => {
	it("keeps the production hosted UI backward-compatible", () => {
		const page = location("https://local.maple.dev/?port=4418")
		expect(localApiBaseForLocation(page)).toBe("http://127.0.0.1:4418")
		expect(localOtlpEndpointForLocation(page)).toBe("http://127.0.0.1:4418")
	})

	it("uses loopback for a custom hosted UI carrying the startup marker", () => {
		const page = location(
			"https://local-staging.maple.dev/preview?channel=next&port=4418&maple-local-api=loopback",
		)
		expect(localApiBaseForLocation(page)).toBe("http://127.0.0.1:4418")
		expect(localOtlpEndpointForLocation(page)).toBe("http://127.0.0.1:4418")
	})

	it("keeps an embedded LAN or TLS-proxied UI same-origin", () => {
		const page = location("https://srvmini2.lan:4418/?api_key=not-propagated")
		expect(localApiBaseForLocation(page)).toBe("")
		expect(localOtlpEndpointForLocation(page)).toBe("https://srvmini2.lan:4418")
	})

	it("keeps the Vite development UI same-origin for its proxied query and OTLP routes", () => {
		const page = location("http://127.0.0.1:4319/")
		expect(localApiBaseForLocation(page)).toBe("")
		expect(localOtlpEndpointForLocation(page)).toBe("http://127.0.0.1:4319")
	})

	it("rejects malformed and out-of-range hosted port parameters", () => {
		expect(localApiBaseForLocation(location("https://local.maple.dev/?port=not-a-port"))).toBe(
			"http://127.0.0.1:4318",
		)
		expect(localApiBaseForLocation(location("https://local.maple.dev/?port=70000"))).toBe(
			"http://127.0.0.1:4318",
		)
	})
})
