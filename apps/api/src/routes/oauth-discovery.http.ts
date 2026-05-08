import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Env } from "../services/Env"

const resourceFromRequest = (req: HttpServerRequest.HttpServerRequest, suffix: string) => {
	const proto = req.headers["x-forwarded-proto"] ?? "https"
	const host = req.headers.host
	if (!host) return suffix
	return `${proto}://${host}${suffix}`
}

const issuerFromDiscoveryUrl = (url: string) => url.replace(/\/\.well-known\/openid-configuration\/?$/, "")

const oauthProtectedResource = (req: HttpServerRequest.HttpServerRequest, issuer: string) =>
	HttpServerResponse.jsonUnsafe(
		{
			resource: resourceFromRequest(req, "/mcp"),
			authorization_servers: [issuer],
			bearer_methods_supported: ["header"],
			resource_documentation: "https://maple.dev/docs/mcp",
		},
		{ headers: { "cache-control": "public, max-age=300" } },
	)

const redirectToDiscovery = (discoveryUrl: string) =>
	HttpServerResponse.redirect(discoveryUrl, {
		status: 302,
		headers: { "cache-control": "public, max-age=300" },
	})

const registrationNotSupported = () =>
	HttpServerResponse.jsonUnsafe(
		{
			error: "registration_not_supported",
			error_description:
				"Dynamic Client Registration is not supported. Pre-register an OAuth client and configure it in your MCP client.",
		},
		{ status: 501 },
	)

export const OAuthDiscoveryRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const env = yield* Env
		const discoveryUrl = env.HAZEL_OAUTH_DISCOVERY_URL
		const issuer = issuerFromDiscoveryUrl(discoveryUrl)

		const protectedResource = (req: HttpServerRequest.HttpServerRequest) =>
			Effect.succeed(oauthProtectedResource(req, issuer))

		const redirect = () => Effect.succeed(redirectToDiscovery(discoveryUrl))

		const register = () => Effect.succeed(registrationNotSupported())

		yield* router.add("GET", "/.well-known/oauth-protected-resource", protectedResource)
		yield* router.add("GET", "/.well-known/oauth-protected-resource/mcp", protectedResource)

		yield* router.add("GET", "/.well-known/oauth-authorization-server", redirect)
		yield* router.add("GET", "/.well-known/oauth-authorization-server/mcp", redirect)

		yield* router.add("GET", "/.well-known/openid-configuration", redirect)
		yield* router.add("GET", "/.well-known/openid-configuration/mcp", redirect)
		yield* router.add("GET", "/mcp/.well-known/openid-configuration", redirect)

		yield* router.add("POST", "/register", register)
	}),
)
