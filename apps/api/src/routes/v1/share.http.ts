/**
 * The unauthenticated share surface.
 *
 * Deliberately has no authorization middleware. A public link must resolve with
 * no credential at all, and an org-only link needs the session resolved
 * *optionally* — middleware would reject an anonymous caller before any handler
 * could see which mode the link is, so the page could never tell "sign in to
 * view this" from "this link does not exist".
 *
 * Uniformity is the security property throughout: an unknown token, a revoked
 * token, and a token whose dashboard was deleted all take the same path and
 * produce the same body, so nothing here is an oracle for whether a given token
 * ever existed.
 */
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerRequest } from "effect/unstable/http"
import {
	MapleApi,
	SHARE_NOT_FOUND_MESSAGE,
	ShareForbiddenError,
	ShareNotFoundError,
	ShareRateLimitedError,
	ShareWidgetDataResponse,
	SharedDashboardResponse,
	type ShareWidgetDataOutcome,
} from "@maple/domain/http"
import { MAX_LIST_RANGE_SECONDS, SHARE_MAX_RANGE_SECONDS } from "@maple/query-engine"
import { hashShareToken } from "@maple/db"
import { redactForShare } from "@maple/widgets/dashboard"
import { Effect, Option, Redacted } from "effect"
import { Env } from "@/platform/Env"
import { AuthService } from "@/services/auth/AuthService"
import {
	ApiV2RateLimiter,
	shareIpRateLimitKey,
	shareTokenRateLimitKey,
} from "@/services/auth/ApiV2RateLimiter"
import { DashboardPersistenceService } from "@/services/dashboards/DashboardPersistenceService"
import { DashboardWidgetDataService } from "@/services/dashboards/DashboardWidgetDataService"
import { SharedDashboardService } from "@/services/dashboards/SharedDashboardService"
import { resolveShareVariables } from "@/services/dashboards/share-variables"
import { resolveShareWindow } from "@/services/dashboards/share-window"

/** Uniform "no such link", used for every reason a token might not resolve. */
const notFound = Effect.fail(new ShareNotFoundError({ message: SHARE_NOT_FOUND_MESSAGE }))

export const HttpSharePublicLive = HttpApiBuilder.group(MapleApi, "sharePublic", (handlers) =>
	Effect.gen(function* () {
		const auth = yield* AuthService
		const env = yield* Env
		const rateLimiter = yield* ApiV2RateLimiter
		const shares = yield* SharedDashboardService
		const persistence = yield* DashboardPersistenceService
		const widgetData = yield* DashboardWidgetDataService

		/**
		 * Two keys, both must pass: per token, so a leaked link cannot be scraped
		 * without bound, and per client IP, so one actor cannot fan out across many
		 * links. Fails open, like the v2 limiter — a limiter outage must not take
		 * every shared dashboard down with it.
		 */
		const enforceRateLimit = Effect.fn("share.rateLimit")(function* (tokenHash: string) {
			const request = yield* HttpServerRequest.HttpServerRequest
			const ip = request.headers["cf-connecting-ip"] ?? "unknown"
			const outcomes = yield* Effect.all([
				rateLimiter.check(shareTokenRateLimitKey(tokenHash.slice(0, 24))),
				rateLimiter.check(shareIpRateLimitKey(ip)),
			])
			if (outcomes.some((outcome) => outcome === "limited")) {
				return yield* Effect.fail(
					new ShareRateLimitedError({
						message: "This shared dashboard is receiving too many requests. Try again shortly.",
					}),
				)
			}
		})

		/**
		 * Resolve a token to its share, enforce the mode, and load the dashboard.
		 *
		 * The single funnel every handler goes through, so mode enforcement cannot
		 * be forgotten on one endpoint and present on another.
		 */
		const openShare = Effect.fn("share.open")(function* (token: string) {
			const hmacKey = Option.map(env.MAPLE_SHARE_TOKEN_HMAC_KEY, Redacted.value)
			// Rate-limited on the hash, so the raw token never becomes a limiter key.
			if (Option.isSome(hmacKey)) yield* enforceRateLimit(hashShareToken(token, hmacKey.value))

			const resolved = yield* shares.resolveByToken(token)
			const { share, orgId } = resolved

			if (share.mode === "org") {
				const request = yield* HttpServerRequest.HttpServerRequest
				const tenant = yield* Effect.option(
					auth.resolveTenant(request.headers as Record<string, string>),
				)

				if (Option.isNone(tenant)) {
					// No org name here: the caller is anonymous, and naming the owning
					// org would tell them something the link itself does not.
					return yield* Effect.fail(
						new ShareForbiddenError({
							message: "This dashboard is shared with its organization only.",
							reason: "signin_required",
						}),
					)
				}

				// Only the org that owns the board. Note an API key cannot reach this
				// branch at all: `AuthService.resolveTenant` accepts session tokens
				// only, so a machine credential resolves to `None` above and is told to
				// sign in — which is right, since "a member of the org" is a statement
				// about a person, not about an org-scoped key.
				if (tenant.value.orgId !== orgId) {
					return yield* Effect.fail(
						new ShareForbiddenError({
							message: "This dashboard belongs to a different organization.",
							reason: "wrong_org",
						}),
					)
				}
			}

			// A dashboard deleted out from under a live share must read as "no such
			// link", identical to an unknown token — never as a distinguishable 500.
			const document = yield* persistence
				.get(orgId, share.dashboardId)
				.pipe(Effect.catch(() => notFound))

			return { share, orgId, document }
		})

		return handlers
			.handle("resolve", ({ payload }) =>
				Effect.gen(function* () {
					const { share, document } = yield* openShare(payload.token)

					const dashboard = redactForShare(document, share.widgetId ?? null)
					if (dashboard === null) {
						// The share names a widget the board no longer has. Same uniform
						// answer: from outside, an emptied link and an unknown one are the
						// same thing.
						return yield* notFound
					}

					return new SharedDashboardResponse({
						mode: share.mode,
						scope: share.widgetId === undefined ? "dashboard" : "widget",
						dashboard,
						limits: {
							maxRangeSeconds: SHARE_MAX_RANGE_SECONDS,
							maxListRangeSeconds: MAX_LIST_RANGE_SECONDS,
						},
						// Only a public single-chart link may be framed by a third party:
						// an org-only link cannot carry a session across origins anyway,
						// and a whole board is not what anyone embeds.
						embeddable: share.mode === "public" && share.widgetId !== undefined,
					})
				}),
			)
			.handle("widgetData", ({ payload }) =>
				Effect.gen(function* () {
					const { share, orgId, document } = yield* openShare(payload.token)
					const window = yield* resolveShareWindow(payload.timeRange)

					// Every where-clause the board could interpolate into, so a free-text
					// value is checked against the actual templates rather than in the
					// abstract.
					const whereClauses = document.widgets.flatMap((widget) => {
						const source = widget.dataSource as { readonly queries?: ReadonlyArray<unknown> }
						return (source.queries ?? []).flatMap((query) => {
							const clause = (query as { readonly whereClause?: unknown }).whereClause
							return typeof clause === "string" ? [clause] : []
						})
					})

					const variableValues = yield* resolveShareVariables(
						(document.variables ?? []) as ReadonlyArray<never>,
						payload.variableValues ?? {},
						{},
						whereClauses,
					)

					const results: Array<ShareWidgetDataOutcome> = []
					for (const request of payload.requests) {
						// A widget-scoped link answers for its own widget and nothing
						// else. Without this, a chart share would be a board share with
						// extra steps.
						if (share.widgetId !== undefined && request.widgetId !== share.widgetId) {
							results.push({
								widgetId: request.widgetId,
								ok: false,
								reason: "not_found",
								message: "That widget is not on this dashboard.",
							})
							continue
						}

						const outcome = yield* widgetData
							.resolve(
								orgId,
								document,
								{ widgetId: request.widgetId, source: request.source ?? "primary" },
								window,
								variableValues,
							)
							.pipe(
								Effect.map(
									(resolved) =>
										({
											widgetId: request.widgetId,
											ok: true,
											data: resolved.data,
											...(resolved.narrowedToSeconds === undefined
												? {}
												: { narrowedToSeconds: resolved.narrowedToSeconds }),
										}) satisfies ShareWidgetDataOutcome,
								),
								// Per-widget failures ride inside a 200: one tile the share
								// cannot serve must not blank its neighbours.
								Effect.catchTags({
									"@maple/http/errors/ShareWidgetNotFoundError": (error) =>
										Effect.succeed({
											widgetId: request.widgetId,
											ok: false as const,
											reason: "not_found" as const,
											message: error.message,
										}),
									"@maple/http/errors/ShareUnsupportedWidgetError": (error) =>
										Effect.succeed({
											widgetId: request.widgetId,
											ok: false as const,
											reason: "unsupported" as const,
											message: error.message,
										}),
								}),
							)
						results.push(outcome)
					}

					return new ShareWidgetDataResponse({ results })
				}),
			)
	}),
)
