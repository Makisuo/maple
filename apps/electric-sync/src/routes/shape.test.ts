import { assert, describe, it } from "@effect/vitest"
import { buildUpstreamShapeUrl, isShapeName, shapeResponseHeaders } from "./shape.http"

const parse = (raw: string) => {
	const url = new URL(raw)
	return { url, params: url.searchParams }
}

describe("isShapeName", () => {
	it("accepts whitelisted shapes and rejects everything else", () => {
		assert.isTrue(isShapeName("dashboards"))
		assert.isTrue(isShapeName("alert_rules"))
		assert.isTrue(isShapeName("error_issues"))
		assert.isTrue(isShapeName("open_error_incidents"))
		assert.isTrue(isShapeName("api_keys"))
		assert.isFalse(isShapeName("users"))
		assert.isFalse(isShapeName("dashboards; drop table"))
		assert.isFalse(isShapeName(null))
		// Must not be fooled by prototype keys.
		assert.isFalse(isShapeName("toString"))
		assert.isFalse(isShapeName("constructor"))
	})
})

describe("buildUpstreamShapeUrl", () => {
	const base = {
		electricUrl: "http://electric:3000",
		orgId: "org_123",
		clientParams: new URLSearchParams(),
	}

	it("pins table + org scope and targets /v1/shape", () => {
		const { url, params } = parse(buildUpstreamShapeUrl({ ...base, shape: "dashboards" }))
		assert.strictEqual(url.pathname, "/v1/shape")
		assert.strictEqual(params.get("table"), "dashboards")
		assert.strictEqual(params.get("where"), `"org_id" = $1`)
		assert.strictEqual(params.get("params[1]"), "org_123")
	})

	it("appends the shape's extra WHERE with the org scope", () => {
		const issues = parse(buildUpstreamShapeUrl({ ...base, shape: "error_issues" })).params
		assert.strictEqual(issues.get("where"), `"org_id" = $1 AND "archived_at" IS NULL`)

		const incidents = parse(buildUpstreamShapeUrl({ ...base, shape: "open_error_incidents" })).params
		assert.strictEqual(incidents.get("where"), `"org_id" = $1 AND "status" = 'open'`)
	})

	it("forwards only the reserved cursor params from the client", () => {
		const clientParams = new URLSearchParams({
			offset: "42_7",
			handle: "abc",
			live: "true",
			cursor: "99",
			shape: "dashboards",
		})
		const { params } = parse(buildUpstreamShapeUrl({ ...base, shape: "dashboards", clientParams }))
		assert.strictEqual(params.get("offset"), "42_7")
		assert.strictEqual(params.get("handle"), "abc")
		assert.strictEqual(params.get("live"), "true")
		assert.strictEqual(params.get("cursor"), "99")
		// The Maple `shape` selector is not forwarded upstream.
		assert.isNull(params.get("shape"))
	})

	it("forwards Electric's cache-recovery params so the client can escape a stale CDN entry", () => {
		// When Electric rotates a shape handle, @electric-sql/client re-requests with
		// `expired_handle` (and a `cache-buster`) set to bust Cloudflare's cache of our
		// upstream fetch. If the proxy drops them the upstream URL is unchanged, the CDN
		// keeps serving the expired-handle response, and the client spins in an infinite
		// 409 loop. So these MUST reach Electric.
		const clientParams = new URLSearchParams({
			offset: "-1",
			expired_handle: "130-9999",
			"cache-buster": "1751742000000",
			shape: "alert_rules",
		})
		const { params } = parse(buildUpstreamShapeUrl({ ...base, shape: "alert_rules", clientParams }))
		assert.strictEqual(params.get("expired_handle"), "130-9999")
		assert.strictEqual(params.get("cache-buster"), "1751742000000")
	})

	it("never lets the client override the pinned table / where / params / columns", () => {
		const malicious = new URLSearchParams()
		malicious.set("table", "api_keys")
		malicious.set("where", "1=1")
		malicious.set("params[1]", "org_victim")
		malicious.set("columns", "org_id,secret")
		malicious.set("replica", "full")

		const { params } = parse(
			buildUpstreamShapeUrl({ ...base, shape: "dashboards", clientParams: malicious }),
		)
		// Pinned values win; the injected ones are ignored entirely.
		assert.strictEqual(params.get("table"), "dashboards")
		assert.strictEqual(params.get("where"), `"org_id" = $1`)
		assert.strictEqual(params.get("params[1]"), "org_123")
		assert.isNull(params.get("columns"))
		assert.isNull(params.get("replica"))
	})

	it("pins a shape's column projection and drops the secret columns", () => {
		const { params } = parse(buildUpstreamShapeUrl({ ...base, shape: "alert_destinations" }))
		const columns = params.get("columns")?.split(",") ?? []
		// PK + org scope must be present for Electric.
		assert.include(columns, "id")
		assert.include(columns, "org_id")
		// The public config the browser renders is allowed…
		assert.include(columns, "config_json")
		// …but the encrypted secret columns must never be projected.
		assert.notInclude(columns, "secret_ciphertext")
		assert.notInclude(columns, "secret_iv")
		assert.notInclude(columns, "secret_tag")
	})

	it("projects only safe API-key display fields", () => {
		const { params } = parse(buildUpstreamShapeUrl({ ...base, shape: "api_keys" }))
		const columns = params.get("columns")?.split(",") ?? []
		assert.strictEqual(params.get("table"), "api_keys")
		assert.strictEqual(params.get("where"), `"org_id" = $1`)
		assert.include(columns, "id")
		assert.include(columns, "org_id")
		assert.include(columns, "key_prefix")
		assert.include(columns, "scopes")
		assert.notInclude(columns, "key_hash")
		assert.notInclude(columns, "metadata_json")
	})

	it("omits the columns param for shapes that sync every column", () => {
		const { params } = parse(buildUpstreamShapeUrl({ ...base, shape: "scrape_target_checks" }))
		assert.isNull(params.get("columns"))
	})

	it("never lets the client widen a column-restricted shape back to secrets", () => {
		const malicious = new URLSearchParams()
		malicious.set("columns", "id,org_id,secret_ciphertext,secret_iv,secret_tag")
		const { params } = parse(
			buildUpstreamShapeUrl({ ...base, shape: "alert_destinations", clientParams: malicious }),
		)
		const columns = params.get("columns")?.split(",") ?? []
		assert.notInclude(columns, "secret_ciphertext")
		assert.include(columns, "config_json")
	})

	it("adds Electric Cloud source credentials only when provided", () => {
		const without = parse(buildUpstreamShapeUrl({ ...base, shape: "dashboards" })).params
		assert.isNull(without.get("source_id"))
		assert.isNull(without.get("secret"))

		const withCreds = parse(
			buildUpstreamShapeUrl({
				...base,
				shape: "dashboards",
				sourceId: "src_1",
				secret: "sh_secret",
			}),
		).params
		assert.strictEqual(withCreds.get("source_id"), "src_1")
		assert.strictEqual(withCreds.get("secret"), "sh_secret")
	})

	it("tolerates a trailing slash on the Electric base URL", () => {
		const { url } = parse(
			buildUpstreamShapeUrl({ ...base, electricUrl: "http://electric:3000/", shape: "dashboards" }),
		)
		assert.strictEqual(url.pathname, "/v1/shape")
		assert.strictEqual(url.host, "electric:3000")
	})
})

describe("shapeResponseHeaders", () => {
	it("adds Vary: Authorization so caches key on the bearer (→ org)", () => {
		const headers = shapeResponseHeaders({ "cache-control": "public, max-age=60" })
		assert.strictEqual(headers.vary, "Authorization")
	})

	it("preserves an existing Vary without duplicating Authorization", () => {
		assert.strictEqual(
			shapeResponseHeaders({ vary: "Accept-Encoding" }).vary,
			"Accept-Encoding, Authorization",
		)
		assert.strictEqual(shapeResponseHeaders({ vary: "authorization" }).vary, "authorization")
		// A pre-existing wildcard already defeats shared caching — leave it be.
		assert.strictEqual(shapeResponseHeaders({ vary: "*" }).vary, "*")
	})

	it("downgrades a public cache-control to private (org rows must not be shared-cached)", () => {
		assert.strictEqual(
			shapeResponseHeaders({ "cache-control": "public, max-age=60" })["cache-control"],
			"private, max-age=60",
		)
	})

	it("leaves no-store / already-private live responses untouched", () => {
		assert.strictEqual(shapeResponseHeaders({ "cache-control": "no-store" })["cache-control"], "no-store")
		assert.strictEqual(
			shapeResponseHeaders({ "cache-control": "private, max-age=5" })["cache-control"],
			"private, max-age=5",
		)
	})

	it("still strips content-encoding / content-length", () => {
		const headers = shapeResponseHeaders({
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
