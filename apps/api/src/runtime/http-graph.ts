import { MapleApi, MapleInternalApi } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { Layer } from "effect"
import { Headers, HttpMiddleware, HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi"
import { API_CORS_OPTIONS } from "@/http/api-cors"
import { McpLive } from "@/mcp/app"
import { Env } from "@/platform/Env"
import { HttpAiSessionsInternalLive } from "@/routes/internal/ai-sessions.http"
import { HttpAiTriageLive } from "@/routes/internal/ai-triage.http"
import { HttpAuthLive, HttpAuthPublicLive } from "@/routes/v1/auth.http"
import { HttpBillingLive } from "@/routes/internal/billing.http"
import { HttpBillingPublicLive } from "@/routes/v1/billing-public.http"
import { HttpV2SharePublicLive } from "@/routes/v2/share.http"
import { ChatSessionsRouter } from "@/routes/v1/chat-sessions.http"
import { HttpChatLive } from "@/routes/internal/chat.http"
import { V1ErrorBoundaryLive } from "@/routes/v1/error-boundary"
import { HttpDemoLive } from "@/routes/internal/demo.http"
import { HttpDigestLive } from "@/routes/internal/digest.http"
import { HttpErrorsLive } from "@/routes/v1/errors.http"
import { HttpIntegrationsLive, IntegrationsCallbackRouter } from "@/routes/v1/integrations.http"
import { OAuthDiscoveryRouter } from "@/routes/v1/oauth-discovery.http"
import { HttpOrgClickHouseSettingsLive } from "@/routes/v1/org-clickhouse-settings.http"
import { HttpOrganizationsLive } from "@/routes/v1/organizations.http"
import { PlanetScaleWebhookRouter } from "@/routes/v1/planetscale-webhook.http"
import { PrometheusScrapeProxyRouter } from "@/routes/v1/prometheus-scrape-proxy.http"
import { HttpQueryEngineLive } from "@/routes/internal/query-engine.http"
import { HttpSessionReplaysInternalLive } from "@/routes/internal/session-replays.http"
import { ScraperInternalRouter } from "@/routes/v1/scraper-internal.http"
import { HttpSessionReplaysLive } from "@/routes/v1/session-replay.http"
import { SlackCallbackRouter, SlackInternalRouter } from "@/routes/v1/slack-integration.http"
import { VcsWebhookRouter } from "@/routes/v1/vcs-webhook.http"
import { HttpV2AlertDeliveriesLive } from "@/routes/v2/alert-deliveries.http"
import { HttpV2AlertDestinationsLive } from "@/routes/v2/alert-destinations.http"
import { HttpV2AlertIncidentsLive } from "@/routes/v2/alert-incidents.http"
import { HttpV2AlertRulesLive } from "@/routes/v2/alert-rules.http"
import { HttpV2AnomaliesLive } from "@/routes/v2/anomalies.http"
import { HttpV2ApiKeysLive } from "@/routes/v2/api-keys.http"
import { HttpV2AttributeMappingsLive } from "@/routes/v2/attribute-mappings.http"
import { HttpV2DashboardsLive } from "@/routes/v2/dashboards.http"
import { V2TransportErrorBoundaryLive } from "@/routes/v2/error-envelope"
import { HttpV2ErrorIssuesLive } from "@/routes/v2/error-issues.http"
import { HttpV2IngestKeysLive } from "@/routes/v2/ingest-keys.http"
import { HttpV2PlanetScaleIntegrationsLive, HttpV2SlackIntegrationsLive } from "@/routes/v2/integrations.http"
import { HttpV2InvestigationsLive } from "@/routes/v2/investigations.http"
import { HttpV2MobileDevicesLive } from "@/routes/v2/mobile-devices.http"
import { HttpV2OrganizationLive } from "@/routes/v2/organization.http"
import { HttpV2InstrumentationRecommendationsLive } from "@/routes/v2/recommendations.http"
import { HttpV2ScrapeTargetsLive } from "@/routes/v2/scrape-targets.http"
import { HttpV2InstrumentationAuditLive } from "@/routes/v2/setup-audit.http"
import { HttpV2SessionReplaysLive } from "@/routes/v2/session-replays.http"
import {
	HttpV2LogsLive,
	HttpV2MetricsLive,
	HttpV2ServiceMapLive,
	HttpV2ServicesLive,
	HttpV2TracesLive,
} from "@/routes/v2/telemetry.http"
import { HttpV2WidgetSummaryLive } from "@/routes/v2/widget-summary.http"
import { HttpV2WidgetCredentialsLive } from "@/routes/v2/widget-credentials.http"
import { ApiAuthorizationLayer } from "@/services/auth/ApiAuthorizationLayer"
import { ApiAuthorizationV2Layer } from "@/services/auth/ApiAuthorizationV2Layer"
import { SessionAuthorizationLayer } from "@/services/auth/SessionAuthorizationLayer"
import { ApiV2RateLimiter } from "@/services/auth/ApiV2RateLimiter"
import { EdgeCacheService } from "@maple/cache"
import { CacheBackendLive } from "@/platform/CacheBackendLive"
import { OrgMembershipService } from "@/services/auth/OrgMembershipService"
import { ApiKeysService } from "@/services/org/ApiKeysService"

const HealthRouter = HttpRouter.use((router) => router.add("GET", "/health", HttpServerResponse.text("OK")))

// `layerCdn` loads Scalar's browser bundle from jsDelivr at runtime instead of
// inlining its ~MB `standalone.min.js` string into the worker bundle — keeps the
// script out of the deployed bundle (guards the 3 MB worker size limit, error
// 10027). The `/docs` page now depends on jsDelivr being reachable from the
// client browser.
const DocsRoute = HttpApiScalar.layerCdn(MapleApi, {
	path: "/docs",
})

// Public v2 API reference (only v2 groups — the internal v1 surface stays on /docs).
const DocsV2Route = HttpApiScalar.layerCdn(MapleApiV2, {
	path: "/v2/docs",
})

const ApiRoutes = HttpApiBuilder.layer(MapleApi).pipe(
	Layer.provide(HttpAuthPublicLive),
	Layer.provide(HttpAuthLive),
	Layer.provide(HttpBillingPublicLive),
	Layer.provide(HttpErrorsLive),
	Layer.provide(HttpIntegrationsLive),
	Layer.provide(HttpOrgClickHouseSettingsLive),
	Layer.provide(HttpOrganizationsLive),
	Layer.provide(HttpSessionReplaysLive),
	Layer.provide(V1ErrorBoundaryLive),
)

/**
 * The dashboard's private transport, served under `/internal/*`.
 *
 * Session-only: `SessionAuthorizationLayer` refuses API-key-shaped bearers, so
 * nothing here is reachable as public API. It is also absent from `/docs`,
 * which is generated from `MapleApi`.
 */
const ApiInternalRoutes = HttpApiBuilder.layer(MapleInternalApi).pipe(
	Layer.provide(
		Layer.mergeAll(HttpQueryEngineLive, HttpSessionReplaysInternalLive, HttpAiSessionsInternalLive),
	),
	Layer.provide(
		Layer.mergeAll(HttpAiTriageLive, HttpBillingLive, HttpChatLive, HttpDemoLive, HttpDigestLive),
	),
	Layer.provide(V1ErrorBoundaryLive),
)

const ApiV2Routes = HttpApiBuilder.layer(MapleApiV2).pipe(
	Layer.provide(
		Layer.mergeAll(
			HttpV2ApiKeysLive,
			HttpV2DashboardsLive,
			HttpV2AlertDeliveriesLive,
			HttpV2AlertRulesLive,
			HttpV2AlertDestinationsLive,
			HttpV2AlertIncidentsLive,
			HttpV2IngestKeysLive,
			HttpV2SlackIntegrationsLive,
			HttpV2PlanetScaleIntegrationsLive,
			HttpV2ErrorIssuesLive,
			HttpV2AttributeMappingsLive,
			HttpV2ScrapeTargetsLive,
			HttpV2InstrumentationRecommendationsLive,
			HttpV2InstrumentationAuditLive,
			HttpV2SharePublicLive,
			HttpV2InvestigationsLive,
			HttpV2AnomaliesLive,
			HttpV2OrganizationLive,
			HttpV2MobileDevicesLive,
			HttpV2SessionReplaysLive,
			HttpV2TracesLive,
			HttpV2LogsLive,
			HttpV2MetricsLive,
			HttpV2ServicesLive,
			HttpV2ServiceMapLive,
			HttpV2WidgetSummaryLive,
			HttpV2WidgetCredentialsLive,
		),
	),
	Layer.provide(V2TransportErrorBoundaryLive),
)

export const AllRoutes = Layer.mergeAll(
	ApiRoutes,
	ApiInternalRoutes,
	ApiV2Routes,
	ChatSessionsRouter,
	IntegrationsCallbackRouter,
	SlackCallbackRouter,
	SlackInternalRouter,
	OAuthDiscoveryRouter,
	PlanetScaleWebhookRouter,
	PrometheusScrapeProxyRouter,
	ScraperInternalRouter,
	VcsWebhookRouter,
	McpLive,
	HealthRouter,
	DocsRoute,
	DocsV2Route,
).pipe(Layer.provideMerge(HttpRouter.cors(API_CORS_OPTIONS)))

export const ApiAuthLive = Layer.mergeAll(
	ApiAuthorizationLayer,
	ApiAuthorizationV2Layer,
	SessionAuthorizationLayer,
).pipe(
	Layer.provideMerge(ApiV2RateLimiter.layer),
	Layer.provideMerge(ApiKeysService.layer),
	// Membership verification for `x-maple-org-id`. Only the v2 layer asks for
	// it; without it that layer cannot build, which is deliberate — the header
	// must never end up silently ignored in a runtime that forgot to wire this.
	Layer.provideMerge(
		OrgMembershipService.layer.pipe(
			Layer.provide(EdgeCacheService.layer.pipe(Layer.provide(CacheBackendLive))),
		),
	),
	Layer.provideMerge(Env.layer),
)

// OAuth callbacks whose query string carries a provider-issued authorization
// `code` (exchangeable for an access token) plus the single-use connect `state`.
// `HttpMiddleware.tracer` stamps `url.full` and `url.query` verbatim on the
// server span — it redacts URL userinfo only, and `Headers.CurrentRedactedNames`
// covers headers, not query parameters — so tracing these requests would retain
// a live bearer credential in telemetry. There is no per-attribute lever, so the
// auto server span is suppressed for them; each callback handler carries its own
// span with safe attributes instead (see `integrations.*OAuthCallback` and
// `slack.oauthCallback`). The second alternative must stay in sync with
// `SLACK_CALLBACK_PATH` — the Slack app install redirects there.
// `/oauth/authorize` is deliberately NOT here: its query carries no bearer
// credential, and `/oauth/token` + `/oauth/revoke` are POSTs (secrets in the body).
const OAUTH_CALLBACK_PATH = /^(?:\/api\/integrations\/[^/]+\/callback|\/oauth\/slack\/callback)(?:\?|$)/

// The OTLP tracer/logger is constructed once at worker module scope and
// provided to the same runtime as the routes. This shared layer installs the
// `TracerDisabledWhen` filter and the header-redaction list — both
// ServiceMap.References read by HttpMiddleware regardless of which Tracer is
// active.
export const ApiObservabilityLive = Layer.mergeAll(
	Layer.succeed(
		HttpMiddleware.TracerDisabledWhen,
		(request: { url: string; method: string }) =>
			request.url === "/health" ||
			request.method === "OPTIONS" ||
			OAUTH_CALLBACK_PATH.test(request.url) ||
			/\.(png|ico|jpg|jpeg|gif|css|js|svg|webp|woff2?)(\?.*)?$/i.test(request.url),
	),
	// Every request header lands on the server span as `http.request.header.<name>`.
	// Effect's defaults cover the usual credential headers; the provider webhook
	// signatures are ours to add (a GitHub webhook HMAC is replayable alongside its
	// body, and there is no reason to retain it).
	Layer.succeed(Headers.CurrentRedactedNames, [
		"authorization",
		"cookie",
		"set-cookie",
		"x-api-key",
		"x-hub-signature",
		"x-hub-signature-256",
	]),
)
