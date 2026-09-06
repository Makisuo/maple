import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type {
	PlanetScaleIntegrationStatus,
	PlanetScaleQueryInsightsResponse,
	SelfDescribingHttpError,
} from "@maple/domain/http"
import { CurrentTenant } from "@maple/domain/http"
import type { PlanetScaleDatabaseRow } from "@maple/db"
import type {
	V2PlanetScaleConnectResponse,
	V2PlanetScaleDatabase,
	V2PlanetScaleDatabaseList,
	V2PlanetScaleDisconnectResponse,
	V2PlanetScaleIntegration,
	V2PlanetScaleOrganizationList,
	V2PlanetScaleWebhookConfig,
	V2SlackChannelList,
	V2SlackIntegrationStatus,
	V2SlackInstallResponse,
	V2SlackUninstallResponse,
} from "@maple/domain/http/v2"
import {
	MapleApiV2,
	V2PlanetScaleEventList,
	V2PlanetScaleQueryInsightList,
	isoTimestamp,
	isoTimestampOrNull,
	V2CallbackHostUnavailable,
	V2InsufficientPermissions,
	V2TimeRangeInvalid,
} from "@maple/domain/http/v2"
import { Array as Arr, Effect, Option } from "effect"
import { recordHttpAudit } from "@/services/audit/AuditLogService"
import { requireAdmin } from "@/services/auth/auth"
import { Env } from "@/platform/Env"
import { EdgeCacheService } from "@maple/cache"
import { PLANETSCALE_CALLBACK_PATH, PlanetScaleOAuthService } from "@/services/auth/PlanetScaleOAuthService"
import { PlanetScaleConnectionService } from "@/services/integrations/PlanetScaleConnectionService"
import { PlanetScaleService } from "@/services/integrations/PlanetScaleService"
import type { SlackChannelList, SlackInstallStatus } from "@/services/integrations/SlackIntegrationService"
import { SLACK_CALLBACK_PATH, SlackIntegrationService } from "@/services/integrations/SlackIntegrationService"

/**
 * Best-effort origin of the incoming request. `x-forwarded-*` is client-supplied
 * on any path that does not strip it, so the result is NOT trusted on its own —
 * every security-relevant use must gate it through {@link isTrustedCallbackOrigin}.
 */
export const resolveRequestOrigin = (req: HttpServerRequest.HttpServerRequest): string => {
	const headers = req.headers as Record<string, string | undefined>
	const forwardedHost = headers["x-forwarded-host"]
	const forwardedProto = headers["x-forwarded-proto"]
	const host = forwardedHost ?? headers.host
	if (host) {
		const proto =
			forwardedProto ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https")
		return `${proto}://${host}`
	}
	return Option.match(Option.liftThrowable(() => new URL(req.url))(), {
		onNone: () => "",
		onSome: (parsed) => `${parsed.protocol}//${parsed.host}`,
	})
}

const hostnameOf = (url: string): string | null =>
	Option.match(Option.liftThrowable(() => new URL(url))(), {
		onNone: () => null,
		onSome: (parsed) => parsed.hostname.toLowerCase(),
	})

/** `app.maple.dev` → `maple.dev`; a single-label host is its own parent. */
const parentDomain = (hostname: string): string => {
	const dot = hostname.indexOf(".")
	return dot === -1 ? hostname : hostname.slice(dot + 1)
}

/**
 * Whether an origin may be used as the Slack OAuth callback origin.
 *
 * The callback URL is embedded in the authorize URL *and* persisted as
 * `oauth_auth_states.redirectUri`, then replayed as `redirect_uri` in the token
 * exchange — so an attacker-chosen origin mints an authorize URL pointing at a
 * host they control. `resolveRequestOrigin` reads `x-forwarded-host`, which any
 * client can set, so it is only accepted when it belongs to the same host family
 * as the trusted `MAPLE_APP_BASE_URL`:
 *
 *   - every deployed stage puts the web app and the API on sibling hosts under
 *     one registrable domain (`app.maple.dev` / `api.maple.dev`, `staging` /
 *     `api-staging`, `app-pr-<n>` / `api-pr-<n>`), and
 *   - local dev puts them on sibling `*.localhost` hosts (portless proxy) or on
 *     loopback ports.
 *
 * Anything else fails closed; Slack's registered-redirect allowlist is then a
 * second line of defense rather than the only one.
 */
export const isTrustedCallbackOrigin = (origin: string, appBaseUrl: string): boolean => {
	const host = hostnameOf(origin)
	const appHost = hostnameOf(appBaseUrl)
	if (host === null || appHost === null) return false
	if (host === appHost) return true
	// Local dev is one family: `*.localhost` (portless proxy) plus loopback IPs
	// (raw-port dev servers with no portless proxy, where web and api sit on
	// different loopback ports).
	const isLocal = (value: string) =>
		value === "localhost" || value.endsWith(".localhost") || value.startsWith("127.") || value === "[::1]"
	if (isLocal(host) || isLocal(appHost)) return isLocal(host) && isLocal(appHost)
	const parent = parentDomain(host)
	// Require a dot so a bare TLD (`evil.dev` vs `app.maple.dev`) never matches.
	return parent.includes(".") && parent === parentDomain(appHost)
}

const toSlackStatus = (status: SlackInstallStatus): V2SlackIntegrationStatus => ({
	object: "slack_integration",
	installed: status.installed,
	team_id: status.teamId,
	team_name: status.teamName,
	bot_user_id: status.botUserId,
	installed_at: isoTimestampOrNull(status.installedAt),
	disconnected_reason: status.disconnectedReason,
	disconnected_team_name: status.disconnectedTeamName,
	disconnected_at: isoTimestampOrNull(status.disconnectedAt),
	missing_scopes: status.missingScopes,
})

const toPlanetScaleStatus = (status: PlanetScaleIntegrationStatus): V2PlanetScaleIntegration => ({
	object: "planetscale_integration",
	connected: status.connected,
	pending_org_selection: status.pendingOrgSelection,
	organization: status.organization,
	connected_by_user_id: status.connectedByUserId,
	detected_permissions: status.detectedPermissions,
	metrics_auth: status.metricsAuth,
	scrape_target:
		status.scrapeTarget === null
			? null
			: {
					id: status.scrapeTarget.id,
					object: "planetscale_integration.scrape_target",
					enabled: status.scrapeTarget.enabled,
					scrape_interval_seconds: status.scrapeTarget.scrapeIntervalSeconds,
					include_branches: status.scrapeTarget.includeBranches,
					exclude_branches: status.scrapeTarget.excludeBranches,
					last_scrape_at: isoTimestampOrNull(status.scrapeTarget.lastScrapeAt),
					last_scrape_error: status.scrapeTarget.lastScrapeError,
				},
	last_inventory_at: isoTimestampOrNull(status.lastInventoryAt),
	last_inventory_error: status.lastInventoryError,
	revoked_at: isoTimestampOrNull(status.revokedAt),
	expires_at: isoTimestampOrNull(status.expiresAt),
})

const toPlanetScaleDatabase = (row: PlanetScaleDatabaseRow): V2PlanetScaleDatabase => ({
	id: row.databaseId,
	object: "planetscale_integration.database",
	name: row.name,
	kind: row.kind,
	state: row.state,
	region: row.region,
	plan: row.plan,
	branches: Arr.map(row.branchesJson ?? [], (branch) => ({
		id: branch.id,
		name: branch.name,
		production: branch.production,
		ready: branch.ready,
	})),
})

const toQueryInsightList = (response: PlanetScaleQueryInsightsResponse): V2PlanetScaleQueryInsightList => ({
	object: "planetscale_integration.query_insight_list",
	branch: response.branch,
	data: Arr.map(response.rows, (row) => ({
		object: "planetscale_integration.query_insight" as const,
		fingerprint: row.fingerprint,
		normalized_sql: row.normalizedSql,
		statement_type: row.statementType,
		query_count: row.queryCount,
		error_count: row.errorCount,
		total_duration_millis: row.totalDurationMillis,
		time_per_query_millis: row.timePerQueryMillis,
		p50_latency_millis: row.p50LatencyMillis,
		p99_latency_millis: row.p99LatencyMillis,
		rows_read_per_query: row.rowsReadPerQuery,
		rows_returned_per_query: row.rowsReturnedPerQuery,
		last_run_at: isoTimestampOrNull(row.lastRunAt),
	})),
	unavailable_reason: response.unavailableReason,
})

const tapHttpErrors =
	(context: string) =>
	<A, Error extends SelfDescribingHttpError, R>(effect: Effect.Effect<A, Error, R>) =>
		effect.pipe(
			Effect.tapError((error) => Effect.logError(context, { tag: error._tag, message: error.message })),
		)

/**
 * Minute-aligned window, so panel refreshes inside the cache TTL share an entry.
 * Also the only place the ISO-8601 wire format meets the epoch-ms the services
 * speak. Rejects an inverted window before any of that.
 */
const resolveWindow = (startTime: string, endTime: string) => {
	const startMs = new Date(startTime).getTime()
	const endMs = new Date(endTime).getTime()
	if (endMs <= startMs) {
		return Effect.fail(
			V2TimeRangeInvalid.make("end_time must be after start_time", { param: "end_time" }),
		)
	}
	const MINUTE = 60_000
	const alignedStart = Math.floor(startMs / MINUTE) * MINUTE
	return Effect.succeed({
		startMs: alignedStart,
		endMs: Math.max(Math.ceil(endMs / MINUTE) * MINUTE, alignedStart + MINUTE),
	})
}

const toChannelList = (list: SlackChannelList): V2SlackChannelList => ({
	object: "slack_integration.channel_list",
	channels: Arr.map(list.channels, (channel) => ({
		id: channel.id,
		name: channel.name,
		is_private: channel.isPrivate,
		is_member: channel.isMember,
	})),
	truncated: list.truncated,
})

export const HttpV2SlackIntegrationsLive = HttpApiBuilder.group(MapleApiV2, "slackIntegration", (handlers) =>
	Effect.gen(function* () {
		const slack = yield* SlackIntegrationService
		const env = yield* Env

		return handlers
			.handle("status", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const status = yield* slack
						.getStatus(tenant.orgId)
						.pipe(tapHttpErrors("Slack integration status failed"))
					return toSlackStatus(status)
				}),
			)
			.handle("install", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, () =>
						V2InsufficientPermissions.make("Only org admins can install the Slack app"),
					)
					const req = yield* HttpServerRequest.HttpServerRequest
					const origin = resolveRequestOrigin(req)
					if (!isTrustedCallbackOrigin(origin, env.MAPLE_APP_BASE_URL)) {
						yield* Effect.logError("Rejected Slack install: untrusted callback origin", {
							origin,
						})
						return yield* Effect.fail(
							V2CallbackHostUnavailable.make("Slack installs are not available from this host"),
						)
					}
					const callbackUrl = `${origin}${SLACK_CALLBACK_PATH}`
					const result = yield* slack
						.startInstall(tenant.orgId, tenant.userId, callbackUrl)
						.pipe(tapHttpErrors("Slack install failed"))
					yield* recordHttpAudit("slack_integration.install_started")
					return {
						object: "slack_integration.install" as const,
						url: result.url,
					} satisfies V2SlackInstallResponse
				}),
			)
			.handle("uninstall", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, () =>
						V2InsufficientPermissions.make("Only org admins can uninstall the Slack app"),
					)
					yield* slack
						.uninstall(tenant.orgId)
						.pipe(tapHttpErrors("Slack integration uninstall failed"))
					yield* recordHttpAudit("slack_integration.uninstalled")
					return {
						object: "slack_integration" as const,
						installed: false as const,
					} satisfies V2SlackUninstallResponse
				}),
			)
			.handle("channels", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					// Admin-gated like install/uninstall: the list leaks the workspace's
					// channel inventory, including *private* channels the bot has been
					// invited to, which is not something every org member should be able
					// to enumerate. `status` deliberately stays ungated — the Slack
					// integration card renders install state for everyone.
					yield* requireAdmin(tenant.roles, () =>
						V2InsufficientPermissions.make("Only org admins can list Slack channels"),
					)
					const list = yield* slack
						.listChannels(tenant.orgId)
						.pipe(tapHttpErrors("Slack channel list failed"))
					return toChannelList(list)
				}),
			)
	}),
)

export const HttpV2PlanetScaleIntegrationsLive = HttpApiBuilder.group(
	MapleApiV2,
	"planetscaleIntegration",
	(handlers) =>
		Effect.gen(function* () {
			const planetscale = yield* PlanetScaleConnectionService
			const planetscaleOAuth = yield* PlanetScaleOAuthService
			const inventory = yield* PlanetScaleService
			const edgeCache = yield* EdgeCacheService
			const env = yield* Env

			return (
				handlers
					.handle("status", () =>
						Effect.gen(function* () {
							const tenant = yield* CurrentTenant.Context
							const status = yield* planetscale
								.getStatus(tenant.orgId)
								.pipe(tapHttpErrors("PlanetScale status failed"))
							return toPlanetScaleStatus(status)
						}),
					)
					.handle("connect", ({ payload }) =>
						Effect.gen(function* () {
							const tenant = yield* CurrentTenant.Context
							yield* requireAdmin(tenant.roles, () =>
								V2InsufficientPermissions.make("Only org admins can connect PlanetScale"),
							)
							const req = yield* HttpServerRequest.HttpServerRequest
							const origin = resolveRequestOrigin(req)
							// v1 skipped this check. The callback URL is persisted as
							// `oauth_auth_states.redirectUri` and replayed as `redirect_uri` in
							// the token exchange, and `resolveRequestOrigin` reads the
							// client-settable `x-forwarded-host` — so an untrusted origin mints
							// an authorize URL pointing at a host the caller controls.
							if (!isTrustedCallbackOrigin(origin, env.MAPLE_APP_BASE_URL)) {
								yield* Effect.logError(
									"Rejected PlanetScale connect: untrusted callback origin",
									{
										origin,
									},
								)
								return yield* Effect.fail(
									V2CallbackHostUnavailable.make(
										"PlanetScale connections are not available from this host",
									),
								)
							}
							const result = yield* planetscaleOAuth
								.startConnect(tenant.orgId, tenant.userId, {
									callbackUrl: `${origin}${PLANETSCALE_CALLBACK_PATH}`,
									returnTo: payload.return_to,
								})
								.pipe(tapHttpErrors("PlanetScale connect failed"))
							yield* recordHttpAudit("planetscale_integration.connect_started")
							return {
								object: "planetscale_integration.connect" as const,
								redirect_url: result.redirectUrl,
								state: result.state,
							} satisfies V2PlanetScaleConnectResponse
						}),
					)
					.handle("organizations", () =>
						Effect.gen(function* () {
							const tenant = yield* CurrentTenant.Context
							// Admin-gated like `select_organization`: this drives the org picker
							// while the connection is pending, and both are admin-only flows.
							yield* requireAdmin(tenant.roles, () =>
								V2InsufficientPermissions.make(
									"Only org admins can manage the PlanetScale integration",
								),
							)
							const organizations = yield* planetscaleOAuth
								.listOrganizations(tenant.orgId)
								.pipe(tapHttpErrors("PlanetScale organization list failed"))
							return {
								object: "planetscale_integration.organization_list" as const,
								organizations: Arr.map(organizations, (org) => ({
									id: org.id,
									name: org.name,
								})),
							} satisfies V2PlanetScaleOrganizationList
						}),
					)
					.handle("selectOrganization", ({ payload }) =>
						Effect.gen(function* () {
							const tenant = yield* CurrentTenant.Context
							yield* requireAdmin(tenant.roles, () =>
								V2InsufficientPermissions.make(
									"Only org admins can manage the PlanetScale integration",
								),
							)
							const status = yield* planetscale
								.finalizeOrgSelection(tenant.orgId, {
									organization: payload.organization,
									includeBranches: payload.include_branches,
									excludeBranches: payload.exclude_branches,
								})
								.pipe(tapHttpErrors("PlanetScale organization selection failed"))
							yield* recordHttpAudit("planetscale_integration.organization_selected", {
								metadata: {
									organization: payload.organization,
									include_branches: payload.include_branches,
									exclude_branches: payload.exclude_branches,
								},
							})
							return toPlanetScaleStatus(status)
						}),
					)
					.handle("setMetricsToken", ({ payload }) =>
						Effect.gen(function* () {
							const tenant = yield* CurrentTenant.Context
							yield* requireAdmin(tenant.roles, () =>
								V2InsufficientPermissions.make(
									"Only org admins can manage the PlanetScale integration",
								),
							)
							const status = yield* planetscale
								.setMetricsToken(tenant.orgId, {
									tokenId: payload.token_id,
									tokenSecret: payload.token_secret,
								})
								.pipe(tapHttpErrors("PlanetScale metrics token update failed"))
							// The token id names which credential was installed; its secret
							// is write-only and never reaches an audit row.
							yield* recordHttpAudit("planetscale_integration.metrics_token_set", {
								metadata: { token_id: payload.token_id },
							})
							return toPlanetScaleStatus(status)
						}),
					)
					.handle("disconnect", () =>
						Effect.gen(function* () {
							const tenant = yield* CurrentTenant.Context
							yield* requireAdmin(tenant.roles, () =>
								V2InsufficientPermissions.make("Only org admins can disconnect PlanetScale"),
							)
							yield* planetscale
								.disconnect(tenant.orgId)
								.pipe(tapHttpErrors("PlanetScale disconnect failed"))
							yield* recordHttpAudit("planetscale_integration.disconnected")
							return {
								object: "planetscale_integration" as const,
								connected: false as const,
							} satisfies V2PlanetScaleDisconnectResponse
						}),
					)
					// No admin gate — any org member may read the inventory (the service map
					// needs it to brand database nodes).
					.handle("databases", () =>
						Effect.gen(function* () {
							const tenant = yield* CurrentTenant.Context
							const [rows, connection] = yield* Effect.all([
								inventory.listDatabases(tenant.orgId),
								planetscale.loadConnection(tenant.orgId),
							]).pipe(tapHttpErrors("PlanetScale database list failed"))
							return {
								object: "planetscale_integration.database_list" as const,
								databases: Arr.map(rows, toPlanetScaleDatabase),
								last_inventory_at: isoTimestampOrNull(
									connection?.lastInventoryAt?.getTime() ?? null,
								),
							} satisfies V2PlanetScaleDatabaseList
						}),
					)
					.handle("webhookConfig", () =>
						Effect.gen(function* () {
							const tenant = yield* CurrentTenant.Context
							// Admin-only: the response carries the webhook HMAC secret.
							yield* requireAdmin(tenant.roles, () =>
								V2InsufficientPermissions.make(
									"Only org admins can read the PlanetScale webhook configuration",
								),
							)
							const req = yield* HttpServerRequest.HttpServerRequest
							const config = yield* planetscale
								.webhookConfig(tenant.orgId)
								.pipe(tapHttpErrors("PlanetScale webhook config failed"))
							return {
								object: "planetscale_integration.webhook_config" as const,
								configured: config.configured,
								// Still a `/api/…` URL: the receiver is a provider-facing raw
								// route, and this exact path is already registered in customers'
								// PlanetScale webhook settings.
								url:
									config.path === null
										? null
										: `${resolveRequestOrigin(req)}${config.path}`,
								secret: config.secret,
							} satisfies V2PlanetScaleWebhookConfig
						}),
					)
					.handle("queryInsights", ({ payload }) =>
						Effect.gen(function* () {
							const tenant = yield* CurrentTenant.Context
							const { startMs, endMs } = yield* resolveWindow(
								payload.start_time,
								payload.end_time,
							)
							const limit = Math.min(Math.max(Math.floor(payload.limit ?? 10), 1), 25)
							const cached = yield* edgeCache.getOrCompute(
								{
									// `-v2` because the cached value is the v2 wire shape now; a
									// v1-shaped entry would fail to decode (a miss, so harmless,
									// but the split keeps both readable during the rollout).
									bucket: "ps-query-insights-v2",
									key: `${tenant.orgId}:${payload.database}:${payload.branch ?? ""}:${startMs}:${endMs}:${limit}`,
									ttlSeconds: 60,
									schema: V2PlanetScaleQueryInsightList,
								},
								inventory
									.queryInsights(tenant.orgId, {
										database: payload.database,
										branch: payload.branch,
										startTime: startMs,
										endTime: endMs,
										limit,
									})
									.pipe(
										Effect.map(toQueryInsightList),
										tapHttpErrors("PlanetScale query insights failed"),
									),
							)
							return cached.value
						}),
					)
					// No admin gate — the timeline is the same class of read as the inventory.
					.handle("events", ({ payload }) =>
						Effect.gen(function* () {
							const tenant = yield* CurrentTenant.Context
							const { startMs, endMs } = yield* resolveWindow(
								payload.start_time,
								payload.end_time,
							)
							const limit = Math.min(Math.max(Math.floor(payload.limit ?? 100), 1), 500)
							const categories = payload.categories ?? []
							const cached = yield* edgeCache.getOrCompute(
								{
									bucket: "ps-events-v2",
									key: `${tenant.orgId}:${payload.database ?? ""}:${payload.branch ?? ""}:${startMs}:${endMs}:${categories.join(",")}:${limit}:${payload.cursor ?? ""}`,
									// Shorter than query-insights' 60s: a deploy marker landing a
									// minute after the deploy is the visible failure mode here.
									ttlSeconds: 30,
									schema: V2PlanetScaleEventList,
								},
								inventory
									.listEvents(tenant.orgId, {
										database: payload.database,
										branch: payload.branch,
										startTime: startMs,
										endTime: endMs,
										categories: categories.length > 0 ? categories : undefined,
										limit,
										cursor: payload.cursor,
									})
									.pipe(
										Effect.map(({ events, nextCursor }) => ({
											object: "planetscale_integration.event_list" as const,
											data: Arr.map(events, (row) => ({
												id: row.id,
												object: "planetscale_integration.event" as const,
												database_name: row.databaseName,
												branch_name: row.branchName,
												category: row.category,
												event_type: row.eventType,
												state: row.state,
												external_id: row.externalId,
												title: row.title,
												source: row.source,
												actor_login: row.actorLogin,
												url: row.url,
												occurred_at: isoTimestamp(row.occurredAt.getTime()),
											})),
											next_cursor: nextCursor,
										})),
										tapHttpErrors("PlanetScale event list failed"),
									),
							)
							return cached.value
						}),
					)
			)
		}),
)
