import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Clock, Effect, Option, Redacted, Schema } from "effect"
import { createHmac, timingSafeEqual } from "node:crypto"
import { SlackBotResolutionResponseSchema, type IntegrationsPersistenceError } from "@maple/domain/http"
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

		yield* router.add("GET", "/internal/slack/workspaces/:teamId", handle)
	}),
)

// ---------------------------------------------------------------------------
// Slack Events API receiver — the reverse direction of `uninstall`: a
// workspace admin removes the app (or revokes its tokens) from Slack's own
// "Manage Apps" UI instead of Maple's dashboard. Subscribe this URL to the
// app_uninstalled and tokens_revoked bot events on the Slack app's Event
// Subscriptions page. `SlackIntegrationService.reconcileWorkspaces` (driven by
// the API worker's cron) is the backstop for deliveries that never arrive.
// ---------------------------------------------------------------------------

export const SLACK_EVENTS_PATH = "/api/integrations/slack/events"

const SLACK_SIGNATURE_VERSION = "v0"
/** Slack's own recommendation: reject requests whose timestamp has drifted this far (replay protection). */
const SLACK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60

/**
 * Verify `X-Slack-Signature` / `X-Slack-Request-Timestamp` against the raw
 * body: HMAC-SHA256 hex of `v0:{timestamp}:{rawBody}`, keyed by the app's
 * signing secret. https://api.slack.com/authentication/verifying-requests-from-slack
 */
const isValidSlackSignature = (
	rawBody: string,
	timestampHeader: string | undefined,
	signatureHeader: string | undefined,
	signingSecret: string,
	nowSeconds: number,
): boolean => {
	if (!timestampHeader || !signatureHeader) return false
	const timestamp = Number(timestampHeader)
	if (!Number.isFinite(timestamp)) return false
	if (Math.abs(nowSeconds - timestamp) > SLACK_TIMESTAMP_TOLERANCE_SECONDS) return false
	const expected = `${SLACK_SIGNATURE_VERSION}=${createHmac("sha256", signingSecret)
		.update(`${SLACK_SIGNATURE_VERSION}:${timestampHeader}:${rawBody}`, "utf8")
		.digest("hex")}`
	const provided = Buffer.from(signatureHeader, "utf8")
	const expectedBuf = Buffer.from(expected, "utf8")
	return provided.length === expectedBuf.length && timingSafeEqual(provided, expectedBuf)
}

/**
 * Loose envelope for Slack's Events API POST body — only the fields this
 * handler acts on. Unlisted keys (token, api_app_id, event_id, event_time, …)
 * decode through untouched.
 */
const SlackEventEnvelope = Schema.Struct({
	type: Schema.String,
	challenge: Schema.optionalKey(Schema.String),
	team_id: Schema.optionalKey(Schema.String),
	event: Schema.optionalKey(Schema.Struct({ type: Schema.String })),
})
const decodeSlackEventEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(SlackEventEnvelope))

/** Narrows a raw Slack event `type` string to the two we act on, or `undefined`. */
const asRevocationEventType = (eventType: string): "app_uninstalled" | "tokens_revoked" | undefined =>
	eventType === "app_uninstalled" || eventType === "tokens_revoked" ? eventType : undefined

export const SlackEventsRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const slack = yield* SlackIntegrationService
		const env = yield* Env

		const handle = Effect.fn("SlackEvents.receive")(function* (req: HttpServerRequest.HttpServerRequest) {
			const signingSecret = Option.match(env.SLACK_SIGNING_SECRET, {
				onNone: () => undefined,
				onSome: Redacted.value,
			})
			if (!signingSecret) {
				yield* Effect.logWarning("Slack event rejected: SLACK_SIGNING_SECRET is not configured")
				return errorText("Slack events are not configured", 503)
			}

			const bodyOption = yield* req.text.pipe(Effect.option)
			if (Option.isNone(bodyOption) || bodyOption.value.length === 0) {
				return errorText("Missing request body", 400)
			}
			const rawBody = bodyOption.value
			const headers = req.headers as Record<string, string | undefined>
			const nowMs = yield* Clock.currentTimeMillis
			if (
				!isValidSlackSignature(
					rawBody,
					headers["x-slack-request-timestamp"],
					headers["x-slack-signature"],
					signingSecret,
					Math.floor(nowMs / 1000),
				)
			) {
				yield* Effect.logWarning("Slack event rejected: signature verification failed")
				return errorText("Invalid signature", 401)
			}

			const envelopeOption = decodeSlackEventEnvelope(rawBody)
			if (Option.isNone(envelopeOption)) {
				return errorText("Malformed event payload", 400)
			}
			const envelope = envelopeOption.value

			// Slack's one-time handshake when the Request URL is first saved/changed.
			if (envelope.type === "url_verification") {
				return envelope.challenge
					? HttpServerResponse.text(envelope.challenge)
					: errorText("Missing challenge", 400)
			}

			const revocationEventType =
				envelope.type === "event_callback" && envelope.event
					? asRevocationEventType(envelope.event.type)
					: undefined
			const teamId = envelope.team_id

			const process: Effect.Effect<void, IntegrationsPersistenceError> =
				revocationEventType && teamId
					? slack.revokeByTeamId(teamId, revocationEventType).pipe(Effect.asVoid)
					: Effect.void

			return yield* process.pipe(
				Effect.tapError((error) =>
					Effect.logError("Slack event-driven revoke failed", {
						teamId,
						eventType: revocationEventType,
						message: error.message,
					}),
				),
				// Slack retries a non-2xx delivery — surface a persistence failure as
				// 500 so a transient DB blip gets retried instead of silently dropped.
				// Every other outcome (including "nothing to do") acks with 200.
				Effect.match({
					onFailure: () => errorText("failed to process event", 500),
					onSuccess: () => HttpServerResponse.text("ok"),
				}),
			)
		})

		yield* router.add("POST", SLACK_EVENTS_PATH, handle)
	}),
)
