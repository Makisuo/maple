import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Effect, Option, Redacted, Schema } from "effect"
import { timingSafeEqual } from "node:crypto"
import { Env } from "../lib/Env"
import {
	SlackIntegrationService,
	SlackBotResolutionResponseSchema,
	SLACK_CALLBACK_PATH,
} from "../services/SlackIntegrationService"

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
				return redirect({ slack: "error", slack_message: "Malformed callback URL" })
			}
			const url = urlOption.value
			const code = url.searchParams.get("code")
			const state = url.searchParams.get("state")
			const oauthError = url.searchParams.get("error")

			if (oauthError) {
				return redirect({ slack: "error", slack_message: oauthError })
			}
			if (!code || !state) {
				return redirect({ slack: "error", slack_message: "Missing code or state in callback" })
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
						...(result.teamName ? { slack_team: result.teamName } : {}),
					}),
				),
				Effect.catchTags({
					"@maple/http/errors/IntegrationsValidationError": (error) =>
						Effect.succeed(redirect({ slack: "error", slack_message: error.message })),
					"@maple/http/errors/IntegrationsForbiddenError": (error) =>
						Effect.succeed(redirect({ slack: "error", slack_message: error.message })),
					"@maple/http/errors/IntegrationsUpstreamError": () =>
						Effect.succeed(
							redirect({ slack: "error", slack_message: "Failed to complete the Slack connection" }),
						),
					"@maple/http/errors/IntegrationsPersistenceError": () =>
						Effect.succeed(
							redirect({ slack: "error", slack_message: "Failed to complete the Slack connection" }),
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

/** Non-empty, trimmed `:teamId` path param. */
const decodeTeamIdParam = Schema.decodeUnknownOption(
	Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isTrimmed())),
)

const encodeBotResolution = Schema.encodeUnknownEffect(SlackBotResolutionResponseSchema)

/**
 * Internal endpoint for the Railway-hosted Slack bot. Given a Slack `teamId`,
 * returns the bound org's decrypted bot token + minted Maple API key so the bot
 * can act on the org's behalf. Guarded by a dedicated internal-service token
 * (`Authorization: Bearer maple_svc_<SLACK_INTERNAL_SERVICE_TOKEN>`), falling
 * back to the shared `INTERNAL_SERVICE_TOKEN` when the dedicated one is unset.
 *
 * Response contract (FIXED — the bot is built against it):
 *   200 → { orgId, teamId, teamName, botToken, mapleApiKey }
 *   404 → unknown or revoked team
 */
export const SlackInternalRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const slack = yield* SlackIntegrationService
		const env = yield* Env
		// Prefer the Slack-bot-specific secret so the Railway bot can hold a token
		// distinct from the MCP-internal one; fall back to the shared token.
		const internalToken = Option.match(
			Option.orElse(env.SLACK_INTERNAL_SERVICE_TOKEN, () => env.INTERNAL_SERVICE_TOKEN),
			{
				onNone: () => undefined,
				onSome: Redacted.value,
			},
		)

		const logAccess = (teamId: string, outcome: "found" | "not-found" | "unauthorized") =>
			Effect.logInfo("Slack internal resolve access", { teamId, outcome })

		const handle = Effect.fn("slack.internalResolve")(function* (
			req: HttpServerRequest.HttpServerRequest,
		) {
			const params = yield* HttpRouter.params
			const teamIdOption = decodeTeamIdParam(
				typeof params.teamId === "string" ? decodeURIComponent(params.teamId) : undefined,
			)
			const teamId = Option.getOrElse(teamIdOption, () => "")
			if (!internalToken) {
				yield* logAccess(teamId, "unauthorized")
				return errorText("Internal service token is not configured", 401)
			}
			if (!isValidServiceBearer(req.headers.authorization, internalToken)) {
				yield* logAccess(teamId, "unauthorized")
				return errorText("Unauthorized", 401)
			}
			if (Option.isNone(teamIdOption)) return errorText("Missing teamId", 400)

			const resolution = yield* slack.resolveForBot(teamIdOption.value).pipe(
				Effect.map(Option.some),
				Effect.catchTag("@maple/http/errors/IntegrationsNotConnectedError", () =>
					Effect.succeedNone,
				),
			)
			return yield* Option.match(resolution, {
				onNone: () =>
					logAccess(teamId, "not-found").pipe(
						Effect.as(errorText("No active Slack installation for this team", 404)),
					),
				onSome: (resolved) =>
					logAccess(teamId, "found").pipe(
						Effect.andThen(encodeBotResolution(resolved).pipe(Effect.orDie)),
						Effect.flatMap((encoded) => HttpServerResponse.json(encoded)),
					),
			})
		})

		yield* router.add("GET", "/internal/slack/workspaces/:teamId", handle)
	}),
)
