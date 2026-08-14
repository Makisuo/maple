import { describe, expect, it } from "vitest"
import { isCloudflareAccessResponse, shouldUseCloudflareAccess } from "./cloudflare-access"

describe("shouldUseCloudflareAccess", () => {
	it("uses cloudflared only for non-loopback HTTPS without explicit Access credentials", () => {
		expect(shouldUseCloudflareAccess("https://maple.example.com", {})).toBe(true)
		expect(shouldUseCloudflareAccess("http://maple.example.com", {})).toBe(false)
		expect(shouldUseCloudflareAccess("https://127.0.0.1:4318", {})).toBe(false)
		expect(shouldUseCloudflareAccess("https://localhost:4318", {})).toBe(false)
		expect(shouldUseCloudflareAccess("https://maple.example.com", { "CF-Access-Client-Id": "id" })).toBe(
			false,
		)
		expect(shouldUseCloudflareAccess("https://maple.example.com", { "CF-ACCESS-TOKEN": "token" })).toBe(
			false,
		)
	})
})

describe("isCloudflareAccessResponse", () => {
	it("recognizes denied responses and Access redirects", () => {
		expect(isCloudflareAccessResponse(401, null)).toBe(true)
		expect(isCloudflareAccessResponse(403, null)).toBe(true)
		expect(
			isCloudflareAccessResponse(302, "https://example.cloudflareaccess.com/cdn-cgi/access/login"),
		).toBe(true)
		expect(isCloudflareAccessResponse(303, "/cdn-cgi/access/login")).toBe(true)
		expect(isCloudflareAccessResponse(302, "https://example.com/login")).toBe(false)
		expect(isCloudflareAccessResponse(500, "/cdn-cgi/access/login")).toBe(false)
	})
})
