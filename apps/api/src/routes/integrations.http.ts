import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	CurrentTenant,
	HazelChannelsListResponse,
	HazelDisconnectResponse,
	HazelIntegrationStatus,
	HazelOrganizationsListResponse,
	HazelStartConnectResponse,
	IntegrationsForbiddenError,
	IntegrationsValidationError,
	MapleApi,
} from "@maple/domain/http"
import { Effect } from "effect"
import { HazelOAuthService } from "../services/HazelOAuthService"

const HAZEL_CALLBACK_PATH = "/api/integrations/hazel/callback"

const resolveRequestOrigin = (req: HttpServerRequest.HttpServerRequest): string => {
	const headers = req.headers as Record<string, string | undefined>
	const forwardedHost = headers["x-forwarded-host"]
	const forwardedProto = headers["x-forwarded-proto"]
	const host = forwardedHost ?? headers.host
	if (host) {
		const proto =
			forwardedProto ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https")
		return `${proto}://${host}`
	}
	// Fall back to parsing req.url which is absolute under wrangler/CF Workers.
	try {
		const parsed = new URL(req.url)
		return `${parsed.protocol}//${parsed.host}`
	} catch {
		return ""
	}
}

const resolveCallbackUrl = (req: HttpServerRequest.HttpServerRequest): string =>
	`${resolveRequestOrigin(req)}${HAZEL_CALLBACK_PATH}`

const ADMIN_ROLES = new Set(["root", "org:admin"])

const requireAdmin = (roles: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		if (roles.some((role) => ADMIN_ROLES.has(role))) return
		yield* Effect.fail(
			new IntegrationsForbiddenError({
				message: "Only org admins can manage integrations",
			}),
		)
	})

export const HttpIntegrationsLive = HttpApiBuilder.group(MapleApi, "integrations", (handlers) =>
	Effect.gen(function* () {
		const hazel = yield* HazelOAuthService

		return handlers
			.handle("hazelStatus", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const status = yield* hazel.getStatus(tenant.orgId)
					if (!status.connected) {
						return new HazelIntegrationStatus({
							connected: false,
							externalUserId: null,
							externalUserEmail: null,
							connectedByUserId: null,
							scope: null,
						})
					}
					return new HazelIntegrationStatus({
						connected: true,
						externalUserId: status.externalUserId,
						externalUserEmail: status.externalUserEmail,
						connectedByUserId: status.connectedByUserId,
						scope: status.scope,
					})
				}),
			)
			.handle("hazelStart", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles as ReadonlyArray<string>)
					const req = yield* HttpServerRequest.HttpServerRequest
					const result = yield* hazel.startConnect(tenant.orgId, tenant.userId, {
						callbackUrl: resolveCallbackUrl(req),
						returnTo: payload.returnTo,
					})
					return new HazelStartConnectResponse(result)
				}),
			)
			.handle("hazelOrganizations", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const organizations = yield* hazel.listOrganizations(tenant.orgId)
					return new HazelOrganizationsListResponse({
						organizations: organizations.map((o) => ({
							id: o.id,
							name: o.name,
							slug: o.slug,
							logoUrl: o.logoUrl,
						})),
					})
				}),
			)
			.handle("hazelChannels", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const channels = yield* hazel.listChannels(tenant.orgId, params.organizationId)
					return new HazelChannelsListResponse({
						channels: channels.map((c) => ({
							id: c.id,
							name: c.name,
							type: c.type,
							organizationId: c.organizationId,
						})),
					})
				}),
			)
			.handle("hazelDisconnect", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles as ReadonlyArray<string>)
					const result = yield* hazel.disconnect(tenant.orgId)
					return new HazelDisconnectResponse(result)
				}),
			)
	}),
)

const escapeHtml = (value: string) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")

const renderCallbackPage = (params: {
	status: "success" | "error"
	message: string
	returnTo: string | null
}) => {
	const safeMessage = escapeHtml(params.message)
	const safeReturn = params.returnTo ? escapeHtml(params.returnTo) : null
	const payload = JSON.stringify({
		type: "maple:integration:hazel",
		status: params.status,
		message: params.message,
	})
	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Maple — Hazel integration</title>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
      body { font-family: -apple-system, system-ui, sans-serif; padding: 2rem; max-width: 28rem; margin: 0 auto; color: #111; }
      .ok { color: #047857; }
      .err { color: #b91c1c; }
      a.button { display: inline-block; margin-top: 1rem; background: #111; color: white; padding: 0.5rem 1rem; border-radius: 0.5rem; text-decoration: none; }
    </style>
  </head>
  <body>
    <h1 class="${params.status === "success" ? "ok" : "err"}">
      ${params.status === "success" ? "Hazel connected" : "Hazel connection failed"}
    </h1>
    <p>${safeMessage}</p>
    ${safeReturn ? `<p><a class="button" href="${safeReturn}">Return to Maple</a></p>` : ""}
    <script>
      try {
        if (window.opener) {
          window.opener.postMessage(${payload}, "*");
          setTimeout(function () { window.close(); }, 600);
        }
      } catch (_) {}
    </script>
  </body>
</html>`
}

const htmlResponse = (body: string, status?: number) => {
	const response = HttpServerResponse.html(body)
	return status === undefined ? response : HttpServerResponse.setStatus(response, status)
}

export const IntegrationsCallbackRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const hazel = yield* HazelOAuthService

		const handle = (req: HttpServerRequest.HttpServerRequest) =>
			Effect.gen(function* () {
				const url = new URL(req.url, "http://localhost")
				const code = url.searchParams.get("code")
				const state = url.searchParams.get("state")
				const oauthError = url.searchParams.get("error")
				const oauthErrorDescription = url.searchParams.get("error_description") ?? oauthError

				if (oauthError) {
					return htmlResponse(
						renderCallbackPage({
							status: "error",
							message: oauthErrorDescription || "Hazel returned an error",
							returnTo: null,
						}),
						400,
					)
				}

				if (!code || !state) {
					return htmlResponse(
						renderCallbackPage({
							status: "error",
							message: "Missing code or state in callback",
							returnTo: null,
						}),
						400,
					)
				}

				return yield* hazel.completeConnect(code, state).pipe(
					Effect.match({
						onFailure: (error) =>
							htmlResponse(
								renderCallbackPage({
									status: "error",
									message:
										error instanceof IntegrationsValidationError
											? error.message
											: "Failed to complete Hazel connection",
									returnTo: null,
								}),
								400,
							),
						onSuccess: (result) =>
							htmlResponse(
								renderCallbackPage({
									status: "success",
									message: "You can close this window and return to Maple.",
									returnTo: result.returnTo,
								}),
							),
					}),
				)
			})

		yield* router.add("GET", "/api/integrations/hazel/callback", handle)
	}),
)
