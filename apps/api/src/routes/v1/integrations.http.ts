import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	CloudflareDisconnectResponse,
	CloudflareHyperdrivesResponse,
	CloudflareStartConnectResponse,
	CloudflareTopTrafficResponse,
	CloudflareTopTrafficRow,
	CloudflareUsageResponse,
	CurrentTenant,
	ExternalUserId,
	GithubDeleteRepositoryResponse,
	GithubDisconnectResponse,
	GithubIntegrationStatus,
	GithubSetTrackedBranchResponse,
	GithubStartConnectResponse,
	HazelChannelsListResponse,
	HazelDisconnectResponse,
	HazelIntegrationStatus,
	HazelOrganizationsListResponse,
	HazelStartConnectResponse,
	IntegrationsForbiddenError,
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	MapleApi,
	RoleName,
	UserId,
	VcsCommitDetailResponse,
} from "@maple/domain/http"
import { cloudflareAnalyticsState } from "@maple/db"
import { EdgeCacheService } from "@maple/cache"
import { and, eq } from "drizzle-orm"
import { Cause, Effect, Option, Schema } from "effect"
import { Database } from "@/platform/DatabaseLive"
import { Env } from "@/platform/Env"
import { graphqlQuery } from "@/services/integrations/CloudflareApi"
import { CloudflareAnalyticsService } from "@/services/integrations/CloudflareAnalyticsService"
import { CloudflareOAuthService } from "@/services/auth/CloudflareOAuthService"
import { abrCount } from "@/services/integrations/cloudflare-analytics/mapping"
import {
	decodeTopTrafficResponse,
	HTTP_DATASET,
	toGraphqlTime,
	topTrafficFilterVariables,
	topTrafficQuery,
	type TopTrafficGroupShape,
} from "@/services/integrations/cloudflare-analytics/queries"
import { PlanetScaleConnectionService } from "@/services/integrations/PlanetScaleConnectionService"
import { PLANETSCALE_CALLBACK_PATH, PlanetScaleOAuthService } from "@/services/auth/PlanetScaleOAuthService"
import { GithubConnectService } from "@/services/integrations/vcs/vendor/github/GithubConnectService"
import { VcsCommitService } from "@/services/integrations/vcs/VcsCommitService"
import { HazelOAuthService } from "@/services/auth/HazelOAuthService"
import { requireAdmin as requireAdminRole } from "@/services/auth/auth"

const asExternalUserId = Schema.decodeUnknownSync(ExternalUserId)
const asUserId = Schema.decodeUnknownSync(UserId)

const HAZEL_CALLBACK_PATH = "/api/integrations/hazel/callback"
const GITHUB_CALLBACK_PATH = "/api/integrations/github/callback"
const CLOUDFLARE_CALLBACK_PATH = "/api/integrations/cloudflare/callback"
const HAZEL_MESSAGE_TYPE = "maple:integration:hazel"
const GITHUB_MESSAGE_TYPE = "maple:integration:github"
const CLOUDFLARE_MESSAGE_TYPE = "maple:integration:cloudflare"
const PLANETSCALE_MESSAGE_TYPE = "maple:integration:planetscale"

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
	return Option.match(Option.liftThrowable(() => new URL(req.url))(), {
		onNone: () => "",
		onSome: (parsed) => `${parsed.protocol}//${parsed.host}`,
	})
}

const resolveCallbackUrl = (req: HttpServerRequest.HttpServerRequest): string =>
	`${resolveRequestOrigin(req)}${HAZEL_CALLBACK_PATH}`

const resolveGithubCallbackUrl = (req: HttpServerRequest.HttpServerRequest): string =>
	`${resolveRequestOrigin(req)}${GITHUB_CALLBACK_PATH}`

const resolveCloudflareCallbackUrl = (req: HttpServerRequest.HttpServerRequest): string =>
	`${resolveRequestOrigin(req)}${CLOUDFLARE_CALLBACK_PATH}`

const requireAdmin = (roles: ReadonlyArray<RoleName>) =>
	requireAdminRole(
		roles,
		() => new IntegrationsForbiddenError({ message: "Only org admins can manage integrations" }),
	)

export const HttpIntegrationsLive = HttpApiBuilder.group(MapleApi, "integrations", (handlers) =>
	Effect.gen(function* () {
		const hazel = yield* HazelOAuthService
		const github = yield* GithubConnectService
		const vcsCommits = yield* VcsCommitService
		const cloudflare = yield* CloudflareOAuthService
		const cloudflareAnalytics = yield* CloudflareAnalyticsService
		const database = yield* Database
		const edgeCache = yield* EdgeCacheService
		const env = yield* Env

		return (
			handlers
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
							externalUserId: asExternalUserId(status.externalUserId),
							externalUserEmail: status.externalUserEmail,
							connectedByUserId: asUserId(status.connectedByUserId),
							scope: status.scope,
						})
					}),
				)
				.handle("hazelStart", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(tenant.roles)
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
						yield* requireAdmin(tenant.roles)
						const result = yield* hazel.disconnect(tenant.orgId)
						return new HazelDisconnectResponse(result)
					}),
				)
				.handle("cloudflareStatus", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						return yield* cloudflareAnalytics.getIntegrationStatus(tenant.orgId)
					}),
				)
				.handle("cloudflareUsage", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						// Two warehouse aggregations per call — 60s edge cache absorbs page-load
						// bursts. The window is server-clocked, so orgId alone keys the entry.
						const cached = yield* edgeCache.getOrCompute(
							{
								bucket: "cf-usage",
								key: tenant.orgId,
								ttlSeconds: 60,
								schema: CloudflareUsageResponse,
							},
							cloudflareAnalytics.getUsage(tenant.orgId),
						)
						return cached.value
					}),
				)
				// No admin gate — any org member may read the inventory (service map needs it).
				// Not connected / never discovered simply reads as an empty config list.
				.handle("cloudflareHyperdrives", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* cloudflareAnalytics.listHyperdriveConfigs(tenant.orgId)
						return new CloudflareHyperdrivesResponse({
							configs: rows.map((row) => ({
								id: row.configId,
								name: row.name,
								originHost: row.originHost,
								originPort: row.originPort,
								originScheme: row.originScheme,
								originDatabase: row.originDatabase,
								originUser: row.originUser,
							})),
						})
					}),
				)
				.handle("cloudflareTopTraffic", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						if (payload.endTime <= payload.startTime) {
							return yield* Effect.fail(
								new IntegrationsValidationError({
									message: "endTime must be after startTime",
								}),
							)
						}
						const limit = Math.min(Math.max(Math.floor(payload.limit ?? 15), 1), 50)
						// Cloudflare applies these before ranking, which is the whole point: the live
						// lookup can reach keys the stored per-window top-N folded into "other".
						const filter = {
							contains: payload.contains?.slice(0, 200),
							hosts: payload.hosts,
							countries: payload.countries,
							methods: payload.methods,
							cacheStatuses: payload.cacheStatuses,
						}
						const filterVariables = topTrafficFilterVariables(filter)
						const isFiltered = Object.keys(filterVariables).length > 0
						// Minute-align the window so repeated dashboard refreshes within the TTL share
						// a cache entry instead of each minting a unique key. Floor the start but CEIL
						// the end (with a one-minute floor on the width): flooring both would collapse
						// a sub-minute window to zero width and cache the resulting empty result.
						const MINUTE = 60_000
						const startMs = Math.floor(payload.startTime / MINUTE) * MINUTE
						const endMs = Math.max(Math.ceil(payload.endTime / MINUTE) * MINUTE, startMs + MINUTE)
						const compute = Effect.gen(function* () {
							const { accessToken } = yield* cloudflare.getValidAccessToken(tenant.orgId)
							const zoneRows = yield* database
								.execute((db) =>
									db
										.select({ zoneId: cloudflareAnalyticsState.zoneId })
										.from(cloudflareAnalyticsState)
										.where(
											and(
												eq(cloudflareAnalyticsState.orgId, tenant.orgId),
												eq(cloudflareAnalyticsState.dataset, HTTP_DATASET),
												eq(cloudflareAnalyticsState.zoneName, payload.zoneName),
											),
										)
										.limit(1),
								)
								.pipe(
									Effect.mapError(
										(cause) =>
											new IntegrationsPersistenceError({
												message:
													cause instanceof Error
														? cause.message
														: "Cloudflare zone lookup failed",
											}),
									),
								)
							const zoneId = zoneRows[0]?.zoneId
							if (zoneId == null) {
								return yield* Effect.fail(
									new IntegrationsValidationError({
										message: `Unknown Cloudflare zone: ${payload.zoneName}`,
									}),
								)
							}
							const result = yield* graphqlQuery(
								accessToken,
								{
									query: topTrafficQuery({ dimension: payload.dimension, limit, filter }),
									variables: {
										zoneTags: [zoneId],
										start: toGraphqlTime(startMs),
										end: toGraphqlTime(endMs),
										...filterVariables,
									},
								},
								env.MAPLE_CLOUDFLARE_API_BASE_URL,
							)
							// GraphQL-level errors here are plan/authz shaped ("dataset not available",
							// window beyond retention) — soft-fail so the card shows an empty state
							// instead of a 5xx toast.
							if (result.errors.length > 0) {
								return new CloudflareTopTrafficResponse({
									rows: [],
									unavailableReason: result.errors
										.map((error) => error.message)
										.join("; ")
										.slice(0, 300),
								})
							}
							const decoded = yield* decodeTopTrafficResponse(result.data).pipe(
								// The card reduces failures to short human copy — keep the real ParseError
								// in the server log so we can see which field of the upstream shape
								// mismatched, matching the OAuth-callback logging pattern above.
								Effect.tapError((error) =>
									Effect.logError("Cloudflare top-traffic response failed to decode", {
										zoneName: payload.zoneName,
										dimension: payload.dimension,
										error: error.message,
									}),
								),
								Effect.mapError(
									() =>
										new IntegrationsUpstreamError({
											message:
												"Cloudflare GraphQL top-traffic response had an unexpected shape",
										}),
								),
							)
							const zone = decoded.viewer.zones?.[0]
							const keyOf = (group: TopTrafficGroupShape) =>
								(payload.dimension === "host"
									? group.dimensions.clientRequestHTTPHost
									: group.dimensions.clientRequestPath) ?? "unknown"
							const byKey = new Map<
								string,
								{ requests: number; bytes: number; errors5xx: number }
							>()
							for (const group of zone?.top ?? []) {
								const key = keyOf(group)
								const entry = byKey.get(key) ?? { requests: 0, bytes: 0, errors5xx: 0 }
								entry.requests += abrCount(group.count, group.avg?.sampleInterval)
								entry.bytes += group.sum?.edgeResponseBytes ?? 0
								byKey.set(key, entry)
							}
							for (const group of zone?.errors ?? []) {
								const key = keyOf(group)
								const entry = byKey.get(key) ?? { requests: 0, bytes: 0, errors5xx: 0 }
								entry.errors5xx += abrCount(group.count, group.avg?.sampleInterval)
								byKey.set(key, entry)
							}
							const rows = [...byKey.entries()]
								.map(
									([key, entry]) =>
										new CloudflareTopTrafficRow({
											key,
											requests: entry.requests,
											bytes: entry.bytes,
											errors5xx: entry.errors5xx,
										}),
								)
								.sort((a, b) => b.requests - a.requests)
								.slice(0, limit)
							return new CloudflareTopTrafficResponse({ rows, unavailableReason: null })
						})
						// The filter digest MUST be in the key — a filtered/unfiltered collision would
						// serve one user's drill-down as another's overview. Sorted so two equivalent
						// selections share an entry.
						const filterDigest = isFiltered
							? JSON.stringify(
									Object.fromEntries(
										Object.entries(filterVariables)
											.sort(([a], [b]) => a.localeCompare(b))
											.map(([key, value]) => [
												key,
												Array.isArray(value) ? [...value].sort() : value,
											]),
									),
								)
							: ""
						const cached = yield* edgeCache.getOrCompute(
							{
								bucket: "cf-top-traffic",
								key: `${tenant.orgId}:${payload.zoneName}:${payload.dimension}:${startMs}:${endMs}:${limit}:${filterDigest}`,
								// Filters explode the key space, so hit rate drops exactly when the
								// upstream budget matters most. An ad-hoc drill-down doesn't need
								// 60s freshness — this endpoint shares the poller's Cloudflare quota.
								ttlSeconds: isFiltered ? 300 : 60,
								schema: CloudflareTopTrafficResponse,
							},
							compute,
						)
						return cached.value
					}),
				)
				.handle("cloudflareStart", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(tenant.roles)
						const req = yield* HttpServerRequest.HttpServerRequest
						const result = yield* cloudflare.startConnect(tenant.orgId, tenant.userId, {
							callbackUrl: resolveCloudflareCallbackUrl(req),
							returnTo: payload.returnTo,
						})
						return new CloudflareStartConnectResponse(result)
					}),
				)
				.handle("cloudflareDisconnect", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(tenant.roles)
						const result = yield* cloudflare.disconnect(tenant.orgId)
						return new CloudflareDisconnectResponse(result)
					}),
				)
				.handle("githubStatus", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const status = yield* github.getStatus(tenant.orgId)
						return new GithubIntegrationStatus({
							connected: status.connected,
							state: status.state,
							accountLogin: status.accountLogin,
							accountType: status.accountType,
							repositorySelection: status.repositorySelection,
							repositories: status.repositories,
						})
					}),
				)
				.handle("githubStart", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(tenant.roles)
						const req = yield* HttpServerRequest.HttpServerRequest
						const result = yield* github.startConnect(tenant.orgId, tenant.userId, {
							callbackUrl: resolveGithubCallbackUrl(req),
							returnTo: payload.returnTo,
						})
						return new GithubStartConnectResponse(result)
					}),
				)
				.handle("githubDisconnect", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(tenant.roles)
						const result = yield* github.disconnect(tenant.orgId)
						return new GithubDisconnectResponse(result)
					}),
				)
				.handle("githubDeleteRepository", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(tenant.roles)
						const result = yield* github.deleteRepository(tenant.orgId, params.repositoryId)
						return new GithubDeleteRepositoryResponse(result)
					}),
				)
				.handle("githubSetTrackedBranch", ({ params, payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(tenant.roles)
						const result = yield* github.setTrackedBranch(
							tenant.orgId,
							params.repositoryId,
							payload.trackedBranch,
						)
						return new GithubSetTrackedBranchResponse(result)
					}),
				)
				// No admin gate — any org member may resolve commit SHAs for hover cards.
				.handle("vcsCommitDetail", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const detail = yield* vcsCommits.resolveCommitDetail(tenant.orgId, params.sha)
						return new VcsCommitDetailResponse(detail)
					}),
				)
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

// JSON.stringify does not escape `<` or `>`, so a payload value of
// `</script><script>alert(1)</script>` would terminate the inline script
// block. Escape these characters and the U+2028 / U+2029 line separators
// (which are valid line terminators in JS but not in JSON) before
// interpolating into a `<script>` body.
const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)
const escapeJsonInHtml = (json: string) =>
	json
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026")
		.split(LINE_SEPARATOR)
		.join("\\u2028")
		.split(PARAGRAPH_SEPARATOR)
		.join("\\u2029")

// The origin we send the popup's result to. It must match the dashboard's origin
// exactly or the browser drops the message, so we reduce MAPLE_APP_BASE_URL to just
// its origin. Falls back to "*" only if that URL can't be parsed.
const resolveDashboardTargetOrigin = (appBaseUrl: string): string =>
	Option.match(Option.liftThrowable(() => new URL(appBaseUrl))(), {
		onNone: () => "*",
		onSome: (parsed) => parsed.origin,
	})

const renderCallbackPage = (params: {
	status: "success" | "error"
	message: string
	returnTo: string | null
	messageType: string
	label: string
	/** Origin the postMessage is sent to (the dashboard). */
	targetOrigin: string
}) => {
	const safeMessage = escapeHtml(params.message)
	const safeReturn = params.returnTo ? escapeHtml(params.returnTo) : null
	const payload = escapeJsonInHtml(
		JSON.stringify({
			type: params.messageType,
			status: params.status,
			message: params.message,
		}),
	)
	// Quote + escape it so the origin can't break out of the inline <script>.
	const targetOrigin = escapeJsonInHtml(JSON.stringify(params.targetOrigin))
	const isSuccess = params.status === "success"
	const glyph = isSuccess
		? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 12.5l5 5 10-11" /></svg>`
		: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>`
	// Theme tokens mirror apps/web/src/styles.css. The dashboard's light/dark
	// choice lives in localStorage on the web origin, which this API-origin
	// popup can't read — prefers-color-scheme is the closest proxy.
	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Maple — ${params.label} integration</title>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
      :root {
        --background: oklch(1 0 0);
        --card: oklch(1 0 0);
        --foreground: oklch(0.141 0.005 285.823);
        --muted-foreground: oklch(0.552 0.016 285.938);
        --border: oklch(0.92 0.004 286.32);
        --primary: oklch(0.66 0.16 59);
        --primary-foreground: oklch(0.21 0.008 67);
        --destructive: oklch(0.577 0.245 27.325);
        --success: oklch(0.508 0.118 165.612);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --background: oklch(0.207 0.008 67);
          --card: oklch(0.224 0.009 75);
          --foreground: oklch(0.91 0.016 74);
          --muted-foreground: oklch(0.603 0.023 72);
          --border: oklch(0.268 0.012 67);
          --primary: oklch(0.714 0.154 59);
          --primary-foreground: oklch(0.207 0.008 67);
          --destructive: oklch(0.654 0.176 30);
          --success: oklch(0.765 0.177 163.223);
        }
      }
      * { box-sizing: border-box; }
      body {
        font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1.5rem;
        background: var(--background);
        color: var(--foreground);
      }
      .card {
        width: 100%;
        max-width: 28rem;
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 2rem;
        text-align: center;
      }
      .glyph {
        width: 2.5rem;
        height: 2.5rem;
        margin: 0 auto 1rem;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        color: ${isSuccess ? "var(--success)" : "var(--destructive)"};
        background: color-mix(in oklch, currentColor 12%, transparent);
      }
      .glyph svg { width: 1.25rem; height: 1.25rem; }
      h1 { font-size: 1rem; font-weight: 600; margin: 0 0 0.5rem; }
      p { font-size: 0.8125rem; line-height: 1.5; color: var(--muted-foreground); margin: 0; }
      a.button {
        display: inline-block;
        margin-top: 1.25rem;
        background: var(--primary);
        color: var(--primary-foreground);
        font: inherit;
        font-size: 0.8125rem;
        font-weight: 500;
        padding: 0.5rem 1rem;
        border-radius: 8px;
        text-decoration: none;
      }
      .wordmark {
        margin-top: 1.5rem;
        font-size: 0.6875rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted-foreground);
        opacity: 0.7;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="glyph">${glyph}</div>
      <h1>${isSuccess ? `${params.label} connected` : `${params.label} connection failed`}</h1>
      <p>${safeMessage}</p>
      ${safeReturn ? `<a class="button" href="${safeReturn}">Return to Maple</a>` : ""}
      <div class="wordmark">Maple</div>
    </main>
    <script>
      try {
        if (window.opener) {
          window.opener.postMessage(${payload}, ${targetOrigin});
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

type CallbackPageParams = {
	status: "success" | "error"
	message: string
	returnTo: string | null
	targetOrigin: string
}

export const IntegrationsCallbackRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const hazel = yield* HazelOAuthService
		const github = yield* GithubConnectService
		const cloudflare = yield* CloudflareOAuthService
		const cloudflareAnalytics = yield* CloudflareAnalyticsService
		const planetscaleOAuth = yield* PlanetScaleOAuthService
		const planetscaleConnection = yield* PlanetScaleConnectionService
		const env = yield* Env

		const dashboardTargetOrigin = resolveDashboardTargetOrigin(env.MAPLE_APP_BASE_URL)
		const hazelCallbackPage = (params: Omit<CallbackPageParams, "targetOrigin">) =>
			renderCallbackPage({
				...params,
				targetOrigin: dashboardTargetOrigin,
				messageType: HAZEL_MESSAGE_TYPE,
				label: "Hazel",
			})
		const githubCallbackPage = (params: Omit<CallbackPageParams, "targetOrigin">) =>
			renderCallbackPage({
				...params,
				targetOrigin: dashboardTargetOrigin,
				messageType: GITHUB_MESSAGE_TYPE,
				label: "GitHub",
			})
		const cloudflareCallbackPage = (params: Omit<CallbackPageParams, "targetOrigin">) =>
			renderCallbackPage({
				...params,
				targetOrigin: dashboardTargetOrigin,
				messageType: CLOUDFLARE_MESSAGE_TYPE,
				label: "Cloudflare",
			})
		const planetscaleCallbackPage = (params: Omit<CallbackPageParams, "targetOrigin">) =>
			renderCallbackPage({
				...params,
				targetOrigin: dashboardTargetOrigin,
				messageType: PLANETSCALE_MESSAGE_TYPE,
				label: "PlanetScale",
			})

		const handle = Effect.fn("integrations.hazelOAuthCallback")(function* (
			req: HttpServerRequest.HttpServerRequest,
		) {
			const urlOption = Option.liftThrowable(() => new URL(req.url, "http://localhost"))()
			if (Option.isNone(urlOption)) {
				return htmlResponse(
					hazelCallbackPage({
						status: "error",
						message: "Malformed callback URL",
						returnTo: null,
					}),
					400,
				)
			}
			const url = urlOption.value
			const code = url.searchParams.get("code")
			const state = url.searchParams.get("state")
			const oauthError = url.searchParams.get("error")
			const oauthErrorDescription = url.searchParams.get("error_description") ?? oauthError

			if (oauthError) {
				return htmlResponse(
					hazelCallbackPage({
						status: "error",
						message: oauthErrorDescription || "Hazel returned an error",
						returnTo: null,
					}),
					400,
				)
			}

			if (!code || !state) {
				return htmlResponse(
					hazelCallbackPage({
						status: "error",
						message: "Missing code or state in callback",
						returnTo: null,
					}),
					400,
				)
			}

			return yield* hazel.completeConnect(code, state).pipe(
				// The callback page reduces failures to short human copy — make sure the real
				// cause still lands in the server log for diagnosis.
				Effect.tapError((error) =>
					Effect.logError("Hazel OAuth completeConnect failed", {
						tag: error._tag,
						message: error.message,
					}),
				),
				Effect.map((result) =>
					htmlResponse(
						hazelCallbackPage({
							status: "success",
							message: "You can close this window and return to Maple.",
							returnTo: result.returnTo,
						}),
					),
				),
				Effect.catchTag("@maple/http/errors/IntegrationsValidationError", (error) =>
					Effect.succeed(
						htmlResponse(
							hazelCallbackPage({
								status: "error",
								message: error.message,
								returnTo: null,
							}),
							400,
						),
					),
				),
				Effect.catchTags({
					"@maple/http/errors/IntegrationsUpstreamError": () =>
						Effect.succeed(
							htmlResponse(
								hazelCallbackPage({
									status: "error",
									message: "Failed to complete Hazel connection",
									returnTo: null,
								}),
								400,
							),
						),
					"@maple/http/errors/IntegrationsPersistenceError": () =>
						Effect.succeed(
							htmlResponse(
								hazelCallbackPage({
									status: "error",
									message: "Failed to complete Hazel connection",
									returnTo: null,
								}),
								400,
							),
						),
				}),
			)
		})

		yield* router.add("GET", "/api/integrations/hazel/callback", handle)

		// Server-kind with the HTTP identity attributes stamped by hand: the auto
		// server span is suppressed for OAuth callbacks (it would record the
		// authorization `code` and connect `state` in `url.full` / `url.query` —
		// see ApiObservabilityLive), so this span is the callback's only trace root.
		// It carries the route and outcome, never the query string.
		const handleGithub = Effect.fn("integrations.githubOAuthCallback", {
			kind: "server",
			attributes: { "http.route": GITHUB_CALLBACK_PATH, "http.request.method": "GET" },
		})(
			function* (req: HttpServerRequest.HttpServerRequest) {
				const urlOption = Option.liftThrowable(() => new URL(req.url, "http://localhost"))()
				if (Option.isNone(urlOption)) {
					return htmlResponse(
						githubCallbackPage({
							status: "error",
							message: "Malformed callback URL",
							returnTo: null,
						}),
						400,
					)
				}
				const url = urlOption.value
				const installationId = url.searchParams.get("installation_id")
				const setupAction = url.searchParams.get("setup_action")
				const state = url.searchParams.get("state")
				// Present only with OAuth-on-install enabled; proves the user owns the install.
				const code = url.searchParams.get("code") ?? undefined
				const oauthError = url.searchParams.get("error")
				const oauthErrorDescription = url.searchParams.get("error_description") ?? oauthError

				if (oauthError) {
					return htmlResponse(
						githubCallbackPage({
							status: "error",
							message: oauthErrorDescription || "GitHub returned an error",
							returnTo: null,
						}),
						400,
					)
				}

				// `setup_action=request` → the org requires admin approval; the
				// installation is pending and carries no usable installation_id yet.
				if (!installationId) {
					return htmlResponse(
						githubCallbackPage({
							status: "error",
							message:
								setupAction === "request"
									? "Installation requested — an org admin must approve it on GitHub, then reconnect."
									: "Missing installation_id in callback",
							returnTo: null,
						}),
						400,
					)
				}

				if (!state) {
					return htmlResponse(
						githubCallbackPage({
							status: "error",
							message:
								"Missing state in callback — GitHub did not return it. Restart the connection from the Maple dashboard.",
							returnTo: null,
						}),
						400,
					)
				}

				return yield* github.completeConnect(installationId, state, code).pipe(
					// The callback page reduces failures to short human copy — make sure the real
					// cause still lands in the server log for diagnosis.
					Effect.tapError((error) =>
						Effect.logError("GitHub OAuth completeConnect failed", {
							tag: error._tag,
							message: error.message,
						}),
					),
					Effect.map((result) =>
						htmlResponse(
							githubCallbackPage({
								status: "success",
								message: "You can close this window and return to Maple.",
								returnTo: result.returnTo,
							}),
						),
					),
					Effect.catchTags({
						"@maple/http/errors/IntegrationsValidationError": (error) =>
							Effect.succeed(
								htmlResponse(
									githubCallbackPage({
										status: "error",
										message: error.message,
										returnTo: null,
									}),
									400,
								),
							),
						"@maple/http/errors/IntegrationsUpstreamError": () =>
							Effect.succeed(
								htmlResponse(
									githubCallbackPage({
										status: "error",
										message: "Failed to complete GitHub connection",
										returnTo: null,
									}),
									400,
								),
							),
						"@maple/http/errors/IntegrationsPersistenceError": () =>
							Effect.succeed(
								htmlResponse(
									githubCallbackPage({
										status: "error",
										message: "Failed to complete GitHub connection",
										returnTo: null,
									}),
									400,
								),
							),
					}),
				)
			},
			// Every branch above returns a response rather than failing, so the status
			// is the only signal separating a completed connect from a rejection.
			Effect.tap((response) =>
				Effect.annotateCurrentSpan({ "http.response.status_code": response.status }),
			),
		)

		yield* router.add("GET", "/api/integrations/github/callback", handleGithub)

		const cloudflareErrorPage = (message: string) =>
			htmlResponse(cloudflareCallbackPage({ status: "error", message, returnTo: null }), 400)

		const handleCloudflare = Effect.fn("integrations.cloudflareOAuthCallback")(function* (
			req: HttpServerRequest.HttpServerRequest,
		) {
			const urlOption = Option.liftThrowable(() => new URL(req.url, "http://localhost"))()
			if (Option.isNone(urlOption)) {
				return cloudflareErrorPage("Malformed callback URL")
			}
			const url = urlOption.value
			const code = url.searchParams.get("code")
			const state = url.searchParams.get("state")
			const oauthError = url.searchParams.get("error")
			const oauthErrorDescription = url.searchParams.get("error_description") ?? oauthError

			if (oauthError) {
				return cloudflareErrorPage(oauthErrorDescription || "Cloudflare returned an error")
			}

			if (!code || !state) {
				return cloudflareErrorPage("Missing code or state in callback")
			}

			return yield* cloudflare.completeConnect(code, state).pipe(
				// The callback page reduces failures to short human copy — make sure the real
				// cause still lands in the server log for diagnosis.
				Effect.tapError((error) =>
					Effect.logError("Cloudflare OAuth completeConnect failed", {
						tag: error._tag,
						message: error.message,
					}),
				),
				// Reconnect writes fresh tokens, but rows a prior revoked-token error disabled
				// (`recordOrgError(..., { disable: true })`) have no other re-enable path for the
				// account-scoped workers anchor row — clear that state now so polling resumes
				// immediately instead of staying dead until something else touches the rows. This
				// must never fail the callback page: the connection itself already succeeded.
				Effect.tap((result) =>
					cloudflareAnalytics.resetOrgState(result.orgId).pipe(
						Effect.catchCause((cause) =>
							Effect.logWarning("cloudflare post-connect state reset failed", {
								orgId: result.orgId,
								error: Cause.pretty(cause),
							}),
						),
					),
				),
				Effect.map((result) =>
					htmlResponse(
						cloudflareCallbackPage({
							status: "success",
							message: "You can close this window and return to Maple.",
							returnTo: result.returnTo,
						}),
					),
				),
				Effect.catchTags({
					// Validation/upstream messages are our own sanitized strings (they embed
					// Cloudflare's OAuth error text) — showing them turns "it failed" into
					// something actionable.
					"@maple/http/errors/IntegrationsValidationError": (error) =>
						Effect.succeed(cloudflareErrorPage(error.message)),
					"@maple/http/errors/IntegrationsUpstreamError": (error) =>
						Effect.succeed(cloudflareErrorPage(error.message)),
					"@maple/http/errors/IntegrationsRevokedError": () =>
						Effect.succeed(
							cloudflareErrorPage(
								"Cloudflare rejected the authorization — reconnect and try again",
							),
						),
					"@maple/http/errors/IntegrationsPersistenceError": () =>
						Effect.succeed(cloudflareErrorPage("Failed to complete Cloudflare connection")),
				}),
			)
		})

		yield* router.add("GET", "/api/integrations/cloudflare/callback", handleCloudflare)

		const planetscaleErrorPage = (message: string) =>
			htmlResponse(planetscaleCallbackPage({ status: "error", message, returnTo: null }), 400)

		const handlePlanetScale = Effect.fn("integrations.planetscaleOAuthCallback")(function* (
			req: HttpServerRequest.HttpServerRequest,
		) {
			const urlOption = Option.liftThrowable(() => new URL(req.url, "http://localhost"))()
			if (Option.isNone(urlOption)) {
				return planetscaleErrorPage("Malformed callback URL")
			}
			const url = urlOption.value
			const code = url.searchParams.get("code")
			const state = url.searchParams.get("state")
			const oauthError = url.searchParams.get("error")
			const oauthErrorDescription = url.searchParams.get("error_description") ?? oauthError

			if (oauthError) {
				return planetscaleErrorPage(oauthErrorDescription || "PlanetScale returned an error")
			}

			if (!code || !state) {
				return planetscaleErrorPage("Missing code or state in callback")
			}

			return yield* planetscaleOAuth.completeConnect(code, state).pipe(
				// Single-org grants finish here (bind + provision the scrape target);
				// multi-org grants leave the org picker to the dashboard. A finalize
				// failure (e.g. missing read_metrics_endpoints scope) surfaces on the
				// callback page — this is the moment the user can act on it.
				Effect.flatMap((result) =>
					result.organizations.length === 1
						? planetscaleConnection
								.finalizeOrgSelection(result.orgId, {
									organization: result.organizations[0]!.name,
								})
								.pipe(
									Effect.map(() => ({
										returnTo: result.returnTo,
										message: `Connected to ${result.organizations[0]!.name}. You can close this window and return to Maple.`,
									})),
								)
						: Effect.succeed({
								returnTo: result.returnTo,
								message:
									"Authorization complete. Choose which PlanetScale organization to connect back in Maple.",
							}),
				),
				// The callback page reduces failures to short human copy — make sure the real
				// cause still lands in the server log for diagnosis.
				Effect.tapError((error) =>
					Effect.logError("PlanetScale OAuth completeConnect failed", {
						tag: error._tag,
						message: error.message,
					}),
				),
				Effect.map(({ returnTo, message }) =>
					htmlResponse(
						planetscaleCallbackPage({
							status: "success",
							message,
							returnTo,
						}),
					),
				),
				Effect.catchTags({
					// Validation/upstream messages are our own sanitized strings — showing
					// them turns "it failed" into something actionable.
					"@maple/http/errors/IntegrationsValidationError": (error) =>
						Effect.succeed(planetscaleErrorPage(error.message)),
					"@maple/http/errors/IntegrationsUpstreamError": (error) =>
						Effect.succeed(planetscaleErrorPage(error.message)),
					"@maple/http/errors/IntegrationsNotConnectedError": () =>
						Effect.succeed(
							planetscaleErrorPage(
								"PlanetScale connection not found — restart the connect flow",
							),
						),
					"@maple/http/errors/IntegrationsRevokedError": () =>
						Effect.succeed(
							planetscaleErrorPage(
								"PlanetScale rejected the authorization — reconnect and try again",
							),
						),
					"@maple/http/errors/IntegrationsPersistenceError": () =>
						Effect.succeed(planetscaleErrorPage("Failed to complete PlanetScale connection")),
				}),
			)
		})

		yield* router.add("GET", PLANETSCALE_CALLBACK_PATH, handlePlanetScale)
	}),
)
