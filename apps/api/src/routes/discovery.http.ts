import { MapleApiV2, v2RouteNotFoundBody } from "@maple/domain/http/v2"
import { mapleMcpServerManifest } from "@maple/domain/mcp-manifest"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { OpenApi } from "effect/unstable/httpapi"
import { Env } from "@/platform/Env"

/**
 * Machine discovery for agents and tooling.
 *
 * - `GET /openapi.json` (+ `/v2/openapi.json`) — the public v2 OpenAPI 3.1
 *   document, the same one `/v2/docs` renders. Built once per isolate: the
 *   derivation walks every group's schemas and is not free.
 * - `GET /.well-known/mcp.json` (+ `/.well-known/mcp/server.json`) — the MCP
 *   registry `server.json` for the hosted MCP server at `/mcp`.
 * - `GET /` — a JSON index pointing at all of the above, so the bare origin
 *   is self-describing instead of an empty 404.
 *
 * Everything here is public, unauthenticated, and cacheable — which is exactly
 * why the self-describing URLs come from the configured `MAPLE_API_BASE_URL` and
 * not from the request. `Host`/`X-Forwarded-*` are client-controlled, so a forged
 * header would otherwise publish (and let an intermediary cache) a manifest that
 * tells MCP clients to send their Maple bearer token to an attacker's origin.
 */

const PUBLIC_CACHE = { "cache-control": "public, max-age=300" }

/**
 * Origin as the CALLER sees it, from headers the caller controls. Deliberately
 * private and used only for the doc links echoed into an uncached 404 body —
 * anything published, cached, or credential-bearing must use the configured
 * `MAPLE_API_BASE_URL` instead.
 */
const untrustedRequestOrigin = (request: HttpServerRequest.HttpServerRequest) => {
	const forwarded = (value: string | undefined) => value?.split(",")[0]?.trim()
	const proto = forwarded(request.headers["x-forwarded-proto"]) ?? "https"
	const host = forwarded(request.headers["x-forwarded-host"]) ?? request.headers.host
	return host ? `${proto}://${host}` : ""
}

let openApiDocument: string | undefined
const openApiJson = Effect.sync(() => {
	openApiDocument ??= JSON.stringify(OpenApi.fromApi(MapleApiV2))
	return openApiDocument
})

const apiIndex = (origin: string) => ({
	name: "Maple API",
	documentation: `${origin}/v2/docs`,
	openapi: `${origin}/openapi.json`,
	mcp: { endpoint: `${origin}/mcp`, manifest: `${origin}/.well-known/mcp.json` },
	health: `${origin}/health`,
	website: "https://maple.dev",
	llms_txt: "https://maple.dev/llms.txt",
})

export const DiscoveryRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const serveOpenApi = Effect.map(openApiJson, (body) =>
			HttpServerResponse.text(body, {
				status: 200,
				contentType: "application/json; charset=utf-8",
				headers: PUBLIC_CACHE,
			}),
		)
		yield* router.add("GET", "/openapi.json", serveOpenApi)
		yield* router.add("GET", "/v2/openapi.json", serveOpenApi)

		const env = yield* Env
		const origin = env.MAPLE_API_BASE_URL.replace(/\/+$/, "")

		const manifest = HttpServerResponse.jsonUnsafe(mapleMcpServerManifest({ apiBaseUrl: origin }), {
			headers: PUBLIC_CACHE,
		})
		const serveManifest = Effect.succeed(manifest)
		yield* router.add("GET", "/.well-known/mcp.json", serveManifest)
		yield* router.add("GET", "/.well-known/mcp/server.json", serveManifest)

		yield* router.add(
			"GET",
			"/",
			Effect.succeed(HttpServerResponse.jsonUnsafe(apiIndex(origin), { headers: PUBLIC_CACHE })),
		)
	}),
)

/**
 * Lowest-precedence catch-all: find-my-way ranks a wildcard below every static
 * and parametric route, so this only fires when nothing else matched. Without
 * it the router's `RouteNotFound` surfaces as a bodyless 404, which an agent
 * cannot distinguish from "this resource does not exist".
 */
export const NotFoundRouter = HttpRouter.use((router) =>
	router.add("*", "/*", (request) => {
		const origin = untrustedRequestOrigin(request)
		const path = request.url.split("?")[0] ?? request.url
		return Effect.succeed(
			HttpServerResponse.jsonUnsafe(
				{
					error: v2RouteNotFoundBody(request.method, path, {
						openApiUrl: `${origin}/openapi.json`,
						docsUrl: `${origin}/v2/docs`,
					}),
				},
				{ status: 404 },
			),
		)
	}),
)
