import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Effect, Option, Redacted } from "effect"
import { timingSafeEqual } from "node:crypto"
import { Env } from "../lib/Env"
import { SlackIntegrationService, SLACK_CALLBACK_PATH } from "../services/SlackIntegrationService"

const INTERNAL_SERVICE_PREFIX = "maple_svc_"

/** Redirect target on the web app after an install attempt. */
const buildAppRedirect = (appBaseUrl: string, params: Record<string, string>): string => {
	const base = appBaseUrl.replace(/\/$/, "")
	// Land on the Slack integration card (route `/integrations`, search `integration`),
	// carrying the `slack=connected|error` return params the card surfaces as a toast.
	const search = new URLSearchParams({ integration: "slack", ...params }).toString()
	return `${base}/integrations?${search}`
}

/**
 * Public Slack OAuth callback (`GET /oauth/slack/callback`). Slack redirects the
 * browser here after the user approves (or denies) the install; we exchange the
 * code, persist the workspace, then redirect the browser back to the web app's
 * integrations page with a success/error query param.
 */
export const SlackCallbackRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const slack = yield* SlackIntegrationService
		const env = yield* Env

		const redirect = (params: Record<string, string>) =>
			HttpServerResponse.redirect(buildAppRedirect(env.MAPLE_APP_BASE_URL, params))

		const handle = Effect.fn("slack.oauthCallback")(function* (
			req: HttpServerRequest.HttpServerRequest,
		) {
			const urlOption = Option.liftThrowable(() => new URL(req.url, "http://localhost"))()
			if (Option.isNone(urlOption)) {
				return redirect({ slack: "error", message: "Malformed callback URL" })
			}
			const url = urlOption.value
			const code = url.searchParams.get("code")
			const state = url.searchParams.get("state")
			const oauthError = url.searchParams.get("error")

			if (oauthError) {
				return redirect({ slack: "error", message: oauthError })
			}
			if (!code || !state) {
				return redirect({ slack: "error", message: "Missing code or state in callback" })
			}

			return yield* slack.completeInstall(code, state).pipe(
				Effect.tapError((error) =>
					Effect.logError("Slack OAuth completeInstall failed", {
						tag: error._tag,
						message: error.message,
					}),
				),
				Effect.map((result) =>
					redirect({
						slack: "connected",
						...(result.teamName ? { team: result.teamName } : {}),
					}),
				),
				Effect.catchTags({
					"@maple/http/errors/IntegrationsValidationError": (error) =>
						Effect.succeed(redirect({ slack: "error", message: error.message })),
					"@maple/http/errors/IntegrationsForbiddenError": (error) =>
						Effect.succeed(redirect({ slack: "error", message: error.message })),
					"@maple/http/errors/IntegrationsUpstreamError": () =>
						Effect.succeed(
							redirect({ slack: "error", message: "Failed to complete the Slack connection" }),
						),
					"@maple/http/errors/IntegrationsPersistenceError": () =>
						Effect.succeed(
							redirect({ slack: "error", message: "Failed to complete the Slack connection" }),
						),
				}),
			)
		})

		yield* router.add("GET", SLACK_CALLBACK_PATH, handle)
	}),
)

const errorText = (message: string, status: number) =>
	HttpServerResponse.text(message, { status, headers: { "content-type": "text/plain; charset=utf-8" } })

/**
 * Constant-time check of an `Authorization: Bearer maple_svc_<token>` header
 * against the configured `INTERNAL_SERVICE_TOKEN`. Mirrors
 * `resolveMcpTenantContext`'s internal-service auth.
 */
const isValidServiceBearer = (
	authorization: string | undefined,
	internalToken: string | undefined,
): boolean => {
	if (!internalToken) return false
	if (!authorization) return false
	const [scheme, token] = authorization.split(" ")
	if (!scheme || !token || scheme.toLowerCase() !== "bearer") return false
	if (!token.startsWith(INTERNAL_SERVICE_PREFIX)) return false
	const provided = token.slice(INTERNAL_SERVICE_PREFIX.length)
	return (
		provided.length === internalToken.length &&
		timingSafeEqual(Buffer.from(provided), Buffer.from(internalToken))
	)
}

/**
 * Internal endpoint for the Railway-hosted Slack bot. Given a Slack `teamId`,
 * returns the bound org's decrypted bot token + minted Maple API key so the bot
 * can act on the org's behalf. Guarded by the shared internal-service token
 * (`Authorization: Bearer maple_svc_<INTERNAL_SERVICE_TOKEN>`).
 *
 * Response contract (FIXED — the bot is built against it):
 *   200 → { orgId, teamId, teamName, botToken, mapleApiKey }
 *   404 → unknown or revoked team
 */
export const SlackInternalRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const slack = yield* SlackIntegrationService
		const env = yield* Env
		const internalToken = Option.match(env.INTERNAL_SERVICE_TOKEN, {
			onNone: () => undefined,
			onSome: Redacted.value,
		})

		const handle = Effect.fn("slack.internalResolve")(function* (
			req: HttpServerRequest.HttpServerRequest,
		) {
			if (!internalToken) return errorText("Internal service token is not configured", 401)
			if (!isValidServiceBearer(req.headers.authorization, internalToken)) {
				return errorText("Unauthorized", 401)
			}
			const url = Option.liftThrowable(() => new URL(req.url, "http://localhost"))()
			const pathname = Option.match(url, { onNone: () => "", onSome: (u) => u.pathname })
			const teamId = decodeURIComponent(pathname.split("/").pop() ?? "")
			if (!teamId) return errorText("Missing teamId", 400)

			const resolution = yield* slack.resolveForBot(teamId).pipe(
				Effect.catchTag("@maple/http/errors/IntegrationsNotConnectedError", () =>
					Effect.succeed(null),
				),
			)
			if (resolution === null) {
				return errorText("No active Slack installation for this team", 404)
			}
			return yield* HttpServerResponse.json({
				orgId: resolution.orgId,
				teamId: resolution.teamId,
				teamName: resolution.teamName,
				botToken: resolution.botToken,
				mapleApiKey: resolution.mapleApiKey,
			})
		})

		yield* router.add("GET", "/internal/slack/workspaces/:teamId", handle)
	}),
)
