import { assert, describe, it } from "@effect/vitest"
import { syncResponseHeaders } from "./headers"

describe("shapeResponseHeaders", () => {
	it("adds Vary: Authorization so caches key on the bearer (→ org)", () => {
		const headers = syncResponseHeaders({ "cache-control": "public, max-age=60" })
		assert.strictEqual(headers.vary, "Authorization")
	})

	it("preserves an existing Vary without duplicating Authorization", () => {
		assert.strictEqual(
			syncResponseHeaders({ vary: "Accept-Encoding" }).vary,
			"Accept-Encoding, Authorization",
		)
		assert.strictEqual(syncResponseHeaders({ vary: "authorization" }).vary, "authorization")
		// A pre-existing wildcard already defeats shared caching — leave it be.
		assert.strictEqual(syncResponseHeaders({ vary: "*" }).vary, "*")
	})

	it("downgrades a public cache-control to private (org rows must not be shared-cached)", () => {
		assert.strictEqual(
			syncResponseHeaders({ "cache-control": "public, max-age=60" })["cache-control"],
			"private, max-age=60",
		)
	})

	it("leaves no-store / already-private live responses untouched", () => {
		assert.strictEqual(syncResponseHeaders({ "cache-control": "no-store" })["cache-control"], "no-store")
		assert.strictEqual(
			syncResponseHeaders({ "cache-control": "private, max-age=5" })["cache-control"],
			"private, max-age=5",
		)
	})

	it("still strips content-encoding / content-length", () => {
		const headers = syncResponseHeaders({
			"content-encoding": "gzip",
			"content-length": "1234",
			"electric-handle": "h1",
		})
		assert.isUndefined(headers["content-encoding"])
		assert.isUndefined(headers["content-length"])
		// Non-stripped upstream headers survive (e.g. the electric-* cursor headers).
		assert.strictEqual(headers["electric-handle"], "h1")
	})
})
