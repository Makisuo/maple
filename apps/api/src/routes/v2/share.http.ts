/**
 * The unauthenticated share surface, served at `/v2/share`.
 *
 * Deliberately has no authorization middleware — the only group on `MapleApiV2`
 * without one; see `packages/domain/src/http/v2/share.ts` for what that costs
 * and why it is still right. A public link must resolve with no credential at
 * all, and an org-only link needs the session resolved *optionally*: middleware
 * would reject an anonymous caller before any handler could see which mode the
 * link is, so the page could never tell "sign in to view this" from "this link
 * does not exist".
 *
 * Note this means the v2 API-key rate limiter never runs for these routes.
 * `enforceRateLimit` below is not a supplement to it — it is the only limiter
 * on this path.
 *
 * Uniformity is the security property throughout: an unknown token, a revoked
 * token, and a token whose dashboard was deleted all take the same path and
 * produce the same body, so nothing here is an oracle for whether a given token
 * ever existed.
 */
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerRequest } from "effect/unstable/http"
import {
	OrgId,
	SHARE_NOT_FOUND_MESSAGE,
	ShareNotConfiguredError,
	ShareNotFoundError,
	ShareOgCardResponse,
	ShareOgMetaResponse,
	ShareRateLimitedError,
	ShareSignInRequiredError,
	ShareWidgetDataResponse,
	SharedDashboardResponse,
	type ShareWidgetDataOutcome,
	ShareWrongOrgError,
} from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { MAX_LIST_RANGE_SECONDS, SHARE_MAX_RANGE_SECONDS } from "@maple/query-engine"
import { hashShareToken, shareOgId, verifyShareOgId } from "@maple/db"
import { redactForShare } from "@maple/widgets/dashboard"
import { Effect, Option, Redacted } from "effect"
import { Env } from "@/platform/Env"
import { AuthService } from "@/services/auth/AuthService"
import {
	ApiV2RateLimiter,
	shareIpRateLimitKey,
	shareOgRateLimitKey,
	shareTokenRateLimitKey,
} from "@/services/auth/ApiV2RateLimiter"
import { DashboardPersistenceService } from "@/services/dashboards/DashboardPersistenceService"
import { DashboardWidgetDataService } from "@/services/dashboards/DashboardWidgetDataService"
import { SharedDashboardService } from "@/services/dashboards/SharedDashboardService"
import { ogDescription, ogSubtitle, ogTiles, ogTitle } from "@/services/dashboards/share-og-card"
import { OrganizationService } from "@/services/org/OrganizationService"
import { resolveShareVariables } from "@/services/dashboards/share-variables"
import { resolveShareWindow } from "@/services/dashboards/share-window"

/** Uniform "no such link", used for every reason a token might not resolve. */
const notFound = Effect.fail(new ShareNotFoundError({ message: SHARE_NOT_FOUND_MESSAGE }))

export const HttpV2SharePublicLive = HttpApiBuilder.group(MapleApiV2, "sharePublic", (handlers) =>
	Effect.gen(function* () {
		const auth = yield* AuthService
		const env = yield* Env
		const rateLimiter = yield* ApiV2RateLimiter
		const organizations = yield* OrganizationService
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
			const ip = request.headers["cf-connecting-ip"]
			// No `cf-connecting-ip` means this is not behind Cloudflare — self-hosted
			// behind another proxy, or local. Bucketing those under a literal
			// "unknown" key would put every viewer in the world in one bucket, so one
			// person could rate-limit everyone. Skip the IP limit there; the per-token
			// limit still applies, and it is the one that bounds a leaked link.
			const outcomes = yield* Effect.all([
				rateLimiter.check(shareTokenRateLimitKey(tokenHash.slice(0, 24))),
				...(ip === undefined ? [] : [rateLimiter.check(shareIpRateLimitKey(ip))]),
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
		 * The preview path's own bucket, per share rather than per viewer.
		 *
		 * No IP key here, deliberately: the callers are crawlers and chat clients
		 * scattered across the internet plus this deployment's own page worker, so
		 * an IP bucket would either be meaningless (one request each) or would put
		 * every share page load behind a single key. The per-share bound is the one
		 * that matters, and it is kept separate from `enforceRateLimit` so unfurl
		 * traffic can never exhaust the bucket protecting the people reading the
		 * board.
		 */
		const enforceOgRateLimit = Effect.fn("share.ogRateLimit")(function* (shareKey: string) {
			const outcome = yield* rateLimiter.check(shareOgRateLimitKey(shareKey.slice(0, 24)))
			if (outcome === "limited") {
				return yield* Effect.fail(
					new ShareRateLimitedError({
						message: "This shared dashboard is receiving too many requests. Try again shortly.",
					}),
				)
			}
		})

		/**
		 * The HMAC key, or the configuration failure.
		 *
		 * `openShare` treats an absent key as "skip the rate limit and let
		 * `resolveByToken` report it", which works because that call fails with
		 * `ShareNotConfiguredError` a line later. The OG handlers need the key for
		 * themselves — to mint and to verify an image id — so they demand it up
		 * front rather than deriving one from nothing.
		 */
		const requireHmacKey = Effect.suspend(() =>
			Option.match(env.MAPLE_SHARE_TOKEN_HMAC_KEY, {
				onNone: () =>
					Effect.fail(
						new ShareNotConfiguredError({
							message: "Dashboard sharing is not configured on this deployment.",
						}),
					),
				onSome: (key) => Effect.succeed(Redacted.value(key)),
			}),
		)

		/**
		 * Who the card says shared the board.
		 *
		 * Best-effort by design: the directory is a third party, and a Clerk
		 * outage — or a self-hosted deployment with no directory at all — must
		 * cost the card its byline, not its render. Only the org's public
		 * identity is read; nothing here reaches for the person who made the link.
		 */
		const ogOrg = Effect.fn("share.ogOrg")(function* (orgId: OrgId) {
			const info = yield* Effect.option(organizations.retrieve(orgId))
			if (Option.isNone(info)) return undefined

			// Self-hosted has no directory, so the name comes back null and the card
			// simply carries no byline.
			const name = info.value.name?.trim()
			if (name === undefined || name.length === 0) return undefined

			const imageUrl = info.value.imageUrl
			return imageUrl === null ? { name } : { name, imageUrl }
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
						new ShareSignInRequiredError({
							message: "This dashboard is shared with its organization only.",
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
						new ShareWrongOrgError({
							message: "This dashboard belongs to a different organization.",
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
								Effect.map((resolved) => {
									const outcome = {
										widgetId: request.widgetId,
										ok: true,
										data: resolved.data,
									} satisfies ShareWidgetDataOutcome
									return resolved.narrowedToSeconds === undefined
										? outcome
										: { ...outcome, narrowedToSeconds: resolved.narrowedToSeconds }
								}),
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
									// `failed` rather than `unsupported`: the tile offers a
									// retry, because the widget is fine and the run was not.
									"@maple/http/errors/ShareWidgetExecutionError": (error) =>
										Effect.succeed({
											widgetId: request.widgetId,
											ok: false as const,
											reason: "failed" as const,
											message: error.message,
										}),
								}),
							)
						results.push(outcome)
					}

					return new ShareWidgetDataResponse({ results })
				}),
			)
			.handle("ogMeta", ({ payload }) =>
				Effect.gen(function* () {
					const hmacKey = yield* requireHmacKey
					yield* enforceOgRateLimit(hashShareToken(payload.token, hmacKey))

					const { share, orgId } = yield* shares.resolveByToken(payload.token)

					// Public only, and taking the uniform not-found path rather than a
					// distinct error: an org-only board's name must not reach whatever
					// renders the link preview, and "this link is org-only" is itself
					// something the anonymous caller does not get to learn.
					if (share.mode !== "public") return yield* notFound

					const document = yield* persistence
						.get(orgId, share.dashboardId)
						.pipe(Effect.catch(() => notFound))

					const dashboard = redactForShare(document, share.widgetId ?? null)
					if (dashboard === null) return yield* notFound

					return new ShareOgMetaResponse({
						title: ogTitle(dashboard, share.widgetId),
						description: ogSubtitle(dashboard, share.widgetId),
						imagePath: `/share/og/${shareOgId(share.id, hmacKey)}.png`,
					})
				}),
			)
			.handle("ogCard", ({ payload }) =>
				Effect.gen(function* () {
					const hmacKey = yield* requireHmacKey
					// Keyed on the id as presented. A tampered id is rejected below, but
					// only after this — otherwise the cheap way to hammer the endpoint
					// would be to send ids that never reach a bucket.
					yield* enforceOgRateLimit(payload.ogId)

					const shareId = verifyShareOgId(payload.ogId, hmacKey)
					if (shareId === undefined) return yield* notFound

					// `resolvePublicById` enforces live-and-public in the query itself,
					// so a revoked link's image URL stops rendering at the same moment
					// the link stops resolving.
					const share = yield* shares.resolvePublicById(shareId)

					const document = yield* persistence
						.get(share.orgId, share.dashboardId)
						.pipe(Effect.catch(() => notFound))

					const dashboard = redactForShare(document, share.widgetId)
					if (dashboard === null) return yield* notFound

					const widgetId = share.widgetId ?? undefined
					const description = ogDescription(dashboard, widgetId)
					const org = yield* ogOrg(share.orgId)

					const card = {
						title: ogTitle(dashboard, widgetId),
						widgetCount: dashboard.widgets.length,
						tiles: ogTiles(dashboard),
					}
					const described = description === undefined ? card : { ...card, description }
					return new ShareOgCardResponse(org === undefined ? described : { ...described, org })
				}),
			)
	}),
)
