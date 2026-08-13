import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Effect, Option, Redacted, Schema } from "effect"
import { timingSafeEqual } from "node:crypto"
import { SlackBotResolutionResponseSchema } from "@maple/domain/http"
import { Env } from "@/platform/Env"
import {
	SlackIntegrationService,
	SLACK_CALLBACK_PATH,
	type SlackRevocationReason,
} from "@/services/integrations/SlackIntegrationService"

const INTERNAL_SERVICE_PREFIX = "maple_svc_"

/** Redirect target on the web app after an install attempt. */
const buildAppRedirect = (appBaseUrl: string, params: Record<string, string>): string => {
	const base = appBaseUrl.replace(/\/$/, "")
	// Land on the Slack integration card (route `/integrations`, search `integration`),
	// carrying the `slack=connected|updated|error` return params the card surfaces as a toast.
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

		const handle = Effect.fn("SlackOAuth.callback")(function* (req: HttpServerRequest.HttpServerRequest) {
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
						// "updated" = an in-place re-auth of the org's active installation
						// (the permissions-refresh flow) — the web app toasts it differently
						// from a first-time connect.
						slack: result.updated ? "updated" : "connected",
						...(result.teamName ? { slack_team: result.teamName } : {}),
					}),
				),
				Effect.catchTags({
					"@maple/http/errors/IntegrationsConfigurationError": () =>
						Effect.succeed(
							redirect({
								slack: "error",
								slack_message: "Slack integration is not configured in Maple",
							}),
						),
					"@maple/http/errors/IntegrationsValidationError": (error) =>
						Effect.succeed(redirect({ slack: "error", slack_message: error.message })),
					"@maple/http/errors/IntegrationsForbiddenError": (error) =>
						Effect.succeed(redirect({ slack: "error", slack_message: error.message })),
					"@maple/http/errors/IntegrationsUpstreamError": () =>
						Effect.succeed(
							redirect({
								slack: "error",
								slack_message: "Failed to complete the Slack connection",
							}),
						),
					"@maple/http/errors/IntegrationsPersistenceError": () =>
						Effect.succeed(
							redirect({
								slack: "error",
								slack_message: "Failed to complete the Slack connection",
							}),
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
 * against the configured `SLACK_INTERNAL_SERVICE_TOKEN`. Mirrors
 * `resolveMcpTenantContext`'s internal-service auth. Compares the UTF-8 bytes —
 * `timingSafeEqual` throws on unequal buffer lengths, and a multi-byte token
 * has fewer UTF-16 code units than bytes.
 */
const isValidServiceBearer = (authorization: string | undefined, internalToken: string): boolean => {
	if (!authorization) return false
	const [scheme, token] = authorization.split(" ")
	if (!scheme || !token || scheme.toLowerCase() !== "bearer") return false
	if (!token.startsWith(INTERNAL_SERVICE_PREFIX)) return false
	const provided = Buffer.from(token.slice(INTERNAL_SERVICE_PREFIX.length), "utf8")
	const expected = Buffer.from(internalToken, "utf8")
	return provided.length === expected.length && timingSafeEqual(provided, expected)
}

/** Non-empty, trimmed `:teamId` path param. */
const decodeTeamIdParam = Schema.decodeUnknownOption(
	Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed()),
)

/** `decodeURIComponent` throws `URIError` on malformed escapes (e.g. `%ZZ`). */
const decodeUriComponentOption = Option.liftThrowable(decodeURIComponent)

const encodeBotResolution = Schema.encodeEffect(SlackBotResolutionResponseSchema)

/**
 * Internal endpoint for the Railway-hosted Slack bot. Given a Slack `teamId`,
 * returns the bound org's decrypted bot token + minted Maple API key so the bot
 * can act on the org's behalf. Guarded by its own secret
 * (`Authorization: Bearer maple_svc_<SLACK_INTERNAL_SERVICE_TOKEN>`) — there is
 * deliberately NO fallback to the shared `INTERNAL_SERVICE_TOKEN`: that token is
 * handed to MCP-internal callers, and holding it must not be enough to harvest
 * every org's bot token and full-access Maple key. The endpoint answers 401
 * until `SLACK_INTERNAL_SERVICE_TOKEN` is set.
 *
 * Response contract (FIXED — the bot is built against it):
 *   200 → { orgId, teamId, teamName, botToken, mapleApiKey }
 *   404 → unknown or revoked team
 */
export const SlackInternalRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const slack = yield* SlackIntegrationService
		const env = yield* Env
		const internalToken = Option.match(env.SLACK_INTERNAL_SERVICE_TOKEN, {
			onNone: () => undefined,
			onSome: Redacted.value,
		})

		const logAccess = Effect.fnUntraced(function* (
			teamId: string | undefined,
			outcome: "found" | "not-found" | "invalid" | "unauthorized" | "unavailable",
			status: number,
		) {
			yield* Effect.annotateCurrentSpan({
				...(teamId === undefined ? {} : { teamId }),
				outcome,
				"http.response.status_code": status,
			})
			// This endpoint hands out decrypted tokens — a rejected caller is a
			// security signal, not routine traffic.
			yield* outcome === "unauthorized"
				? Effect.logWarning("Slack internal resolve rejected", { teamId, outcome })
				: Effect.logInfo("Slack internal resolve access", { teamId, outcome })
		})

		const handle = Effect.fn("SlackInternal.resolve")(function* (
			req: HttpServerRequest.HttpServerRequest,
		) {
			// Auth first: everything below (including path-param decoding) must be
			// unreachable for an unauthenticated caller.
			if (!internalToken) {
				yield* logAccess(undefined, "unauthorized", 401)
				return errorText("Slack internal service token is not configured", 401)
			}
			if (!isValidServiceBearer(req.headers.authorization, internalToken)) {
				yield* logAccess(undefined, "unauthorized", 401)
				return errorText("Unauthorized", 401)
			}

			const params = yield* HttpRouter.params
			const teamIdOption = decodeTeamIdParam(
				typeof params.teamId === "string"
					? Option.getOrUndefined(decodeUriComponentOption(params.teamId))
					: undefined,
			)
			if (Option.isNone(teamIdOption)) {
				yield* logAccess(undefined, "invalid", 400)
				return errorText("Missing teamId", 400)
			}
			const teamId = teamIdOption.value

			return yield* slack.resolveForBot(teamId).pipe(
				Effect.flatMap((resolved) =>
					logAccess(teamId, "found", 200).pipe(
						Effect.andThen(encodeBotResolution(resolved).pipe(Effect.orDie)),
						Effect.flatMap((encoded) => HttpServerResponse.json(encoded)),
					),
				),
				Effect.catchTags({
					"@maple/http/errors/IntegrationsNotConnectedError": () =>
						logAccess(teamId, "not-found", 404).pipe(
							Effect.as(errorText("No active Slack installation for this team", 404)),
						),
					"@maple/http/errors/IntegrationsPersistenceError": (error) =>
						Effect.logError("Slack internal resolve failed", {
							teamId,
							message: error.message,
						}).pipe(
							Effect.andThen(logAccess(teamId, "unavailable", 503)),
							Effect.as(errorText("Slack workspace lookup unavailable", 503)),
						),
				}),
			)
		})

		// Revoke-by-team-id — the reverse direction of `uninstall`: a workspace
		// admin removes the app (or revokes its tokens) from Slack's own "Manage
		// Apps" UI instead of Maple's dashboard.
		//
		// Slack only allows ONE Events API Request URL per app, and it is already
		// pointed at the Railway-hosted bot (apps/slack-agent), which owns Slack
		// signature verification there (its own `SLACK_SIGNING_SECRET` /
		// `webhookVerifier`). So this endpoint does NOT receive Slack traffic
		// directly — the bot detects `app_uninstalled` / `tokens_revoked` in its
		// webhook handler and calls this internal endpoint, authenticated the
		// same way as the resolve endpoint above (dedicated bearer, no fallback
		// to the shared `INTERNAL_SERVICE_TOKEN`).
		//
		// `SlackIntegrationService.reconcileWorkspaces` (driven by the API
		// worker's cron) is the backstop for a call the bot never made — a crash
		// mid-processing, a network blip to Maple, or an installation that
		// predates this wiring.

		const decodeRevokeBody = Schema.decodeUnknownOption(
			Schema.Struct({ reason: Schema.Literals(["app_uninstalled", "tokens_revoked"]) }),
		)

		const handleRevoke = Effect.fn("SlackInternal.revoke")(function* (
			req: HttpServerRequest.HttpServerRequest,
		) {
			if (!internalToken) {
				yield* logAccess(undefined, "unauthorized", 401)
				return errorText("Slack internal service token is not configured", 401)
			}
			if (!isValidServiceBearer(req.headers.authorization, internalToken)) {
				yield* logAccess(undefined, "unauthorized", 401)
				return errorText("Unauthorized", 401)
			}

			const params = yield* HttpRouter.params
			const teamIdOption = decodeTeamIdParam(
				typeof params.teamId === "string"
					? Option.getOrUndefined(decodeUriComponentOption(params.teamId))
					: undefined,
			)
			if (Option.isNone(teamIdOption)) {
				yield* logAccess(undefined, "invalid", 400)
				return errorText("Missing teamId", 400)
			}
			const teamId = teamIdOption.value

			const bodyOption = yield* req.text.pipe(Effect.option)
			const reasonOption = Option.flatMap(bodyOption, (body) =>
				Option.liftThrowable(() => JSON.parse(body))().pipe(Option.flatMap(decodeRevokeBody)),
			)
			if (Option.isNone(reasonOption)) {
				yield* logAccess(teamId, "invalid", 400)
				return errorText('Body must be JSON: { "reason": "app_uninstalled" | "tokens_revoked" }', 400)
			}
			const reason: SlackRevocationReason = reasonOption.value.reason

			return yield* slack.revokeByTeamId(teamId, reason).pipe(
				Effect.flatMap((result) =>
					logAccess(teamId, result.revoked ? "found" : "not-found", 200).pipe(
						Effect.andThen(HttpServerResponse.json({ revoked: result.revoked })),
					),
				),
				Effect.catchTag("@maple/http/errors/IntegrationsPersistenceError", (error) =>
					Effect.logError("Slack internal revoke failed", {
						teamId,
						reason,
						message: error.message,
					}).pipe(
						Effect.andThen(logAccess(teamId, "unavailable", 503)),
						Effect.as(errorText("Slack workspace revoke unavailable", 503)),
					),
				),
			)
		})

		yield* router.add("GET", "/internal/slack/workspaces/:teamId", handle)
		yield* router.add("POST", "/internal/slack/workspaces/:teamId/revoke", handleRevoke)
	}),
)
