import { describe, expect, it } from "vitest"

import { resolveElectricSyncBaseUrl, resolveSyncProxyUrl } from "./electric-sync-url"

describe("resolveElectricSyncBaseUrl", () => {
	it("prefers the configured origin over dev and same-origin defaults", () => {
		expect(
			resolveElectricSyncBaseUrl({
				configured: "https://sync.example.com/",
				isDev: true,
				origin: "http://127.0.0.1:8080",
			}),
		).toBe("https://sync.example.com")
	})

	it("uses the local electric-sync worker in Vite dev", () => {
		expect(
			resolveElectricSyncBaseUrl({
				configured: undefined,
				isDev: true,
				origin: "http://127.0.0.1:3471",
			}),
		).toBe("http://127.0.0.1:3476")
	})

	it("uses the browser origin when the production SPA is same-origin behind Caddy", () => {
		expect(
			resolveElectricSyncBaseUrl({
				configured: "  ",
				isDev: false,
				origin: "http://127.0.0.1:8080/",
			}),
		).toBe("http://127.0.0.1:8080")
	})
})

describe("resolveSyncProxyUrl", () => {
	it("is an absolute URL ShapeStream can construct without a base", () => {
		const url = resolveSyncProxyUrl("http://127.0.0.1:8080")
		expect(() => new URL(url)).not.toThrow()
		expect(new URL(url).pathname).toBe("/api/sync/shape")
	})

	it("refuses an empty base instead of emitting a relative path", () => {
		expect(() => resolveSyncProxyUrl("")).toThrow(/absolute URL/)
	})
})
