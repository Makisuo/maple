import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import {
	MCP_OAUTH_SCOPE,
	McpOAuthProtocolError,
	McpOAuthRateLimitError,
	McpOAuthService,
} from "../services/McpOAuthService"

const RegistrationRequest = Schema.Struct({
	client_name: Schema.String,
	redirect_uris: Schema.Array(Schema.String),
	client_uri: Schema.optionalKey(Schema.String),
	token_endpoint_auth_method: Schema.optionalKey(Schema.String),
	grant_types: Schema.optionalKey(Schema.Array(Schema.String)),
	response_types: Schema.optionalKey(Schema.Array(Schema.String)),
})

const decodeRegistrationRequest = Schema.decodeUnknownEffect(RegistrationRequest)

const forwardedValue = (value: string | undefined) => value?.split(",")[0]?.trim()

export const requestOrigin = (request: HttpServerRequest.HttpServerRequest) => {
	const proto = forwardedValue(request.headers["x-forwarded-proto"]) ?? "https"
	const host = forwardedValue(request.headers["x-forwarded-host"]) ?? request.headers.host
	return host ? `${proto}://${host}` : ""
}

const requesterKey = (request: HttpServerRequest.HttpServerRequest) =>
	request.headers["cf-connecting-ip"] ?? forwardedValue(request.headers["x-forwarded-for"]) ?? "unknown"

const noStoreHeaders = { "cache-control": "no-store", pragma: "no-cache" }

const oauthJson = (body: unknown, status = 200) =>
	HttpServerResponse.jsonUnsafe(body, { status, headers: noStoreHeaders })

const oauthError = (error: string, description: string, status = 400) =>
	oauthJson({ error, error_description: description }, status)

const appendOAuthError = (error: McpOAuthProtocolError) => {
	const url = new URL(error.redirectUri!)
	url.searchParams.set("error", error.error)
	url.searchParams.set("error_description", error.message)
	if (error.state) url.searchParams.set("state", error.state)
	return url.toString()
}

const metadata = (issuer: string) => ({
	issuer,
	authorization_endpoint: `${issuer}/oauth/authorize`,
	token_endpoint: `${issuer}/oauth/token`,
	registration_endpoint: `${issuer}/register`,
	revocation_endpoint: `${issuer}/oauth/revoke`,
	response_types_supported: ["code"],
	grant_types_supported: ["authorization_code", "refresh_token"],
	code_challenge_methods_supported: ["S256"],
	token_endpoint_auth_methods_supported: ["none"],
	scopes_supported: [MCP_OAUTH_SCOPE],
})

const protectedResourceMetadata = (origin: string) => ({
	resource: `${origin}/mcp`,
	authorization_servers: [origin],
	bearer_methods_supported: ["header"],
	scopes_supported: [MCP_OAUTH_SCOPE],
	resource_documentation: "https://maple.dev/docs/mcp",
})

const toWebRequest = Effect.fn("McpOAuthRouter.toWebRequest")(function* () {
	const request = yield* HttpServerRequest.HttpServerRequest
	return yield* HttpServerRequest.toWeb(request).pipe(
		Effect.mapError(
			() => new McpOAuthProtocolError({ error: "invalid_request", message: "Unable to read request" }),
		),
	)
})

const readJson = Effect.fn("McpOAuthRouter.readJson")(function* () {
	const request = yield* toWebRequest()
	return yield* Effect.tryPromise({
		try: () => request.json(),
		catch: () =>
			new McpOAuthProtocolError({
				error: "invalid_request",
				message: "Request body must be valid JSON",
			}),
	})
})

const readForm = Effect.fn("McpOAuthRouter.readForm")(function* () {
	const request = yield* toWebRequest()
	const text = yield* Effect.tryPromise({
		try: () => request.text(),
		catch: () =>
			new McpOAuthProtocolError({ error: "invalid_request", message: "Unable to read form body" }),
	})
	return new URLSearchParams(text)
})

const requireFormValue = (form: URLSearchParams, name: string) => {
	const value = form.get(name)
	return value && value.length > 0
		? Effect.succeed(value)
		: Effect.fail(new McpOAuthProtocolError({ error: "invalid_request", message: `${name} is required` }))
}

const protocolResponse = (error: McpOAuthProtocolError) =>
	Effect.succeed(
		error.redirectUri
			? HttpServerResponse.redirect(appendOAuthError(error), { status: 302 })
			: oauthError(error.error, error.message),
	)

const tokenProtocolResponse = (error: McpOAuthProtocolError) =>
	Effect.succeed(oauthError(error.error, error.message))

const rateLimitResponse = (error: McpOAuthRateLimitError) =>
	Effect.succeed(oauthError("slow_down", error.message, 429))

export const OAuthDiscoveryRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const oauth = yield* McpOAuthService

		const authorizationServerMetadata = (request: HttpServerRequest.HttpServerRequest) =>
			Effect.succeed(
				HttpServerResponse.jsonUnsafe(metadata(requestOrigin(request)), {
					headers: { "cache-control": "public, max-age=300" },
				}),
			)

		const protectedResource = (request: HttpServerRequest.HttpServerRequest) =>
			Effect.succeed(
				HttpServerResponse.jsonUnsafe(protectedResourceMetadata(requestOrigin(request)), {
					headers: { "cache-control": "public, max-age=300" },
				}),
			)

		const register = (request: HttpServerRequest.HttpServerRequest) =>
			Effect.gen(function* () {
				const body = yield* readJson()
				const decoded = yield* decodeRegistrationRequest(body).pipe(
					Effect.mapError(
						() =>
							new McpOAuthProtocolError({
								error: "invalid_client_metadata",
								message: "Invalid registration payload",
							}),
					),
				)
				if (decoded.token_endpoint_auth_method && decoded.token_endpoint_auth_method !== "none") {
					return yield* new McpOAuthProtocolError({
						error: "invalid_client_metadata",
						message: "Only token_endpoint_auth_method=none is supported",
					})
				}
				if (
					decoded.grant_types?.some(
						(grant) => grant !== "authorization_code" && grant !== "refresh_token",
					)
				) {
					return yield* new McpOAuthProtocolError({
						error: "invalid_client_metadata",
						message: "Only authorization_code and refresh_token grants are supported",
					})
				}
				if (decoded.response_types?.some((responseType) => responseType !== "code")) {
					return yield* new McpOAuthProtocolError({
						error: "invalid_client_metadata",
						message: "Only response_type=code is supported",
					})
				}
				const result = yield* oauth.register(
					{
						clientName: decoded.client_name,
						redirectUris: decoded.redirect_uris,
						...(decoded.client_uri ? { clientUri: decoded.client_uri } : {}),
					},
					requesterKey(request),
				)
				return oauthJson(result, 201)
			}).pipe(
				Effect.catchTag("@maple/api/errors/McpOAuthProtocolError", tokenProtocolResponse),
				Effect.catchTag("@maple/api/errors/McpOAuthRateLimitError", rateLimitResponse),
				Effect.catchTag("@maple/http/errors/McpOAuthPersistenceError", (error) =>
					Effect.succeed(oauthError("temporarily_unavailable", error.message, 503)),
				),
			)

		const authorize = (request: HttpServerRequest.HttpServerRequest) =>
			Effect.gen(function* () {
				const native = yield* HttpServerRequest.toWeb(request)
				const url = new URL(native.url)
				const result = yield* oauth.startAuthorization(
					{
						clientId: url.searchParams.get("client_id") ?? "",
						redirectUri: url.searchParams.get("redirect_uri") ?? "",
						responseType: url.searchParams.get("response_type") ?? "",
						...(url.searchParams.get("state") ? { state: url.searchParams.get("state")! } : {}),
						codeChallenge: url.searchParams.get("code_challenge") ?? "",
						codeChallengeMethod: url.searchParams.get("code_challenge_method") ?? "",
						resource: url.searchParams.get("resource") ?? "",
						...(url.searchParams.get("scope") ? { scope: url.searchParams.get("scope")! } : {}),
						expectedResource: `${requestOrigin(request)}/mcp`,
					},
					requesterKey(request),
				)
				return HttpServerResponse.redirect(result.consentUrl, {
					status: 302,
					headers: noStoreHeaders,
				})
			}).pipe(
				Effect.catchTag("@maple/api/errors/McpOAuthProtocolError", protocolResponse),
				Effect.catchTag("@maple/api/errors/McpOAuthRateLimitError", rateLimitResponse),
				Effect.catchTag("@maple/http/errors/McpOAuthPersistenceError", (error) =>
					Effect.succeed(oauthError("temporarily_unavailable", error.message, 503)),
				),
			)

		const token = (request: HttpServerRequest.HttpServerRequest) =>
			Effect.gen(function* () {
				const form = yield* readForm()
				const grantType = yield* requireFormValue(form, "grant_type")
				const clientId = yield* requireFormValue(form, "client_id")
				const resource = yield* requireFormValue(form, "resource")
				const key = requesterKey(request)
				if (grantType === "authorization_code") {
					const response = yield* oauth.exchangeAuthorizationCode(
						{
							code: yield* requireFormValue(form, "code"),
							clientId,
							redirectUri: yield* requireFormValue(form, "redirect_uri"),
							codeVerifier: yield* requireFormValue(form, "code_verifier"),
							resource,
						},
						key,
					)
					return oauthJson(response)
				}
				if (grantType === "refresh_token") {
					const response = yield* oauth.refresh(
						{
							refreshToken: yield* requireFormValue(form, "refresh_token"),
							clientId,
							resource,
							...(form.get("scope") ? { scope: form.get("scope")! } : {}),
						},
						key,
					)
					return oauthJson(response)
				}
				return yield* new McpOAuthProtocolError({
					error: "unsupported_grant_type",
					message: "Only authorization_code and refresh_token grants are supported",
				})
			}).pipe(
				Effect.catchTag("@maple/api/errors/McpOAuthProtocolError", tokenProtocolResponse),
				Effect.catchTag("@maple/api/errors/McpOAuthRateLimitError", rateLimitResponse),
				Effect.catchTag("@maple/http/errors/McpOAuthPersistenceError", (error) =>
					Effect.succeed(oauthError("temporarily_unavailable", error.message, 503)),
				),
			)

		const revoke = () =>
			Effect.gen(function* () {
				const form = yield* readForm()
				const token = yield* requireFormValue(form, "token")
				const clientId = yield* requireFormValue(form, "client_id")
				yield* oauth.revoke(token, clientId)
				return HttpServerResponse.empty({ status: 200, headers: noStoreHeaders })
			}).pipe(
				Effect.catchTag("@maple/api/errors/McpOAuthProtocolError", tokenProtocolResponse),
				Effect.catchTag("@maple/http/errors/McpOAuthPersistenceError", () =>
					Effect.succeed(HttpServerResponse.empty({ status: 200, headers: noStoreHeaders })),
				),
			)

		yield* router.add("GET", "/.well-known/oauth-protected-resource", protectedResource)
		yield* router.add("GET", "/.well-known/oauth-protected-resource/mcp", protectedResource)
		yield* router.add("GET", "/.well-known/oauth-authorization-server", authorizationServerMetadata)
		yield* router.add("GET", "/.well-known/oauth-authorization-server/mcp", authorizationServerMetadata)
		yield* router.add("POST", "/register", register)
		yield* router.add("GET", "/oauth/authorize", authorize)
		yield* router.add("POST", "/oauth/token", token)
		yield* router.add("POST", "/oauth/revoke", revoke)
	}),
)
