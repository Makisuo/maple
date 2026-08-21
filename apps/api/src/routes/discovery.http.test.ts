import { afterAll, describe, expect, it } from "@effect/vitest"
import { MAPLE_MCP_SERVER_NAME } from "@maple/domain/mcp-manifest"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { DiscoveryRouter, NotFoundRouter } from "./discovery.http"

// A registered route that must keep winning over the catch-all.
const ProbeRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		yield* router.add("GET", "/probe", HttpServerResponse.text("probe"))
		yield* router.add("GET", "/things/:id", HttpServerResponse.text("thing"))
	}),
)

const { handler, dispose } = HttpRouter.toWebHandler(
	Layer.mergeAll(DiscoveryRouter, NotFoundRouter, ProbeRouter),
	{ disableLogger: true },
)
afterAll(() => dispose())

const get = (path: string, init?: RequestInit) =>
	handler(
		new Request(`https://api.example.com${path}`, {
			headers: { host: "api.example.com", "x-forwarded-proto": "https" },
			...init,
		}),
	)

describe("DiscoveryRouter", () => {
	it("serves the v2 OpenAPI document as JSON at /openapi.json and /v2/openapi.json", async () => {
		for (const path of ["/openapi.json", "/v2/openapi.json"]) {
			const response = await get(path)
			expect(response.status).toBe(200)
			expect(response.headers.get("content-type")).toContain("application/json")
			const doc = await response.json()
			expect(doc.openapi).toMatch(/^3\.1\./)
			expect(doc.info.title).toBe("Maple API")
			expect(doc.servers).toEqual([{ url: "https://api.maple.dev", description: "Production" }])
			expect(Object.keys(doc.paths).length).toBeGreaterThan(20)
			const operations = Object.values(doc.paths).flatMap((item) =>
				Object.values(item as Record<string, { operationId?: string; description?: string }>),
			)
			for (const operation of operations) {
				expect(operation.operationId).toEqual(expect.any(String))
				expect(operation.description).toEqual(expect.any(String))
			}
		}
	})

	it("serves the MCP server.json manifest under /.well-known", async () => {
		for (const path of ["/.well-known/mcp.json", "/.well-known/mcp/server.json"]) {
			const response = await get(path)
			expect(response.status).toBe(200)
			expect(response.headers.get("content-type")).toContain("application/json")
			const manifest = await response.json()
			expect(manifest.name).toBe(MAPLE_MCP_SERVER_NAME)
			expect(manifest.remotes).toEqual([
				expect.objectContaining({ type: "streamable-http", url: "https://api.example.com/mcp" }),
			])
		}
	})

	it("answers the bare origin with a JSON index", async () => {
		const response = await get("/")
		expect(response.status).toBe(200)
		const index = await response.json()
		expect(index.openapi).toBe("https://api.example.com/openapi.json")
		expect(index.mcp.endpoint).toBe("https://api.example.com/mcp")
	})
})

describe("NotFoundRouter", () => {
	it("returns the v2 error envelope for an unmatched path on any method", async () => {
		for (const method of ["GET", "POST", "DELETE"]) {
			const response = await get("/v2/does-not-exist?x=1", { method })
			expect(response.status).toBe(404)
			expect(response.headers.get("content-type")).toContain("application/json")
			const body = await response.json()
			expect(body.error).toMatchObject({
				_tag: "@maple/http/v2/RouteNotFoundError",
				type: "not_found_error",
				code: "route_not_found",
				retryable: false,
				recovery: "fix_request",
			})
			expect(body.error.message).toContain(`${method} /v2/does-not-exist`)
			expect(body.error.message).toContain("https://api.example.com/openapi.json")
			expect(body.error.message).toContain("https://api.example.com/v2/docs")
		}
	})

	it("never shadows a registered static or parametric route", async () => {
		expect(await (await get("/probe")).text()).toBe("probe")
		expect(await (await get("/things/42")).text()).toBe("thing")
	})
})
