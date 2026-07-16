import { MapleApi } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { Layer } from "effect"
import { HttpMiddleware, HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi"
import { McpLive } from "./mcp/app"
import { HttpBillingLive, HttpBillingPublicLive } from "./routes/billing.http"
import { HttpAiTriageLive } from "./routes/ai-triage.http"
import { HttpAlertsLive } from "./routes/alerts.http"
import { HttpAnomaliesLive } from "./routes/anomalies.http"
import { HttpErrorsLive } from "./routes/errors.http"
import { HttpApiKeysLive } from "./routes/api-keys.http"
import { HttpV2ApiKeysLive } from "./routes/v2/api-keys.http"
import { V2SchemaErrorsLive } from "./routes/v2/error-envelope"
import { HttpAuthLive, HttpAuthPublicLive } from "./routes/auth.http"
import { HttpChatLive } from "./routes/chat.http"
import { HttpDashboardsLive } from "./routes/dashboards.http"
import { HttpDemoLive } from "./routes/demo.http"
import { HttpDigestLive } from "./routes/digest.http"
import { HttpIntegrationsLive, IntegrationsCallbackRouter } from "./routes/integrations.http"
import { HttpInvestigationsLive } from "./routes/investigations.http"
import { HttpIngestAttributeMappingsLive } from "./routes/ingest-attribute-mappings.http"
import { HttpIngestKeysLive } from "./routes/ingest-keys.http"
import { HttpObservabilityLive } from "./routes/observability.http"
import { HttpOnboardingLive } from "./routes/onboarding.http"
import { OAuthDiscoveryRouter } from "./routes/oauth-discovery.http"
import { HttpOrgClickHouseSettingsLive } from "./routes/org-clickhouse-settings.http"
import { HttpOrganizationsLive } from "./routes/organizations.http"
import { PlanetScaleWebhookRouter } from "./routes/planetscale-webhook.http"
import { PrometheusScrapeProxyRouter } from "./routes/prometheus-scrape-proxy.http"
import { ScraperInternalRouter } from "./routes/scraper-internal.http"
import { VcsWebhookRouter } from "./routes/vcs-webhook.http"
import { HttpQueryEngineLive } from "./routes/query-engine.http"
import { HttpRecommendationIssuesLive } from "./routes/recommendation-issues.http"
import { HttpScrapeTargetsLive } from "./routes/scrape-targets.http"
import { HttpSessionReplaysLive } from "./routes/session-replay.http"
import { HttpWarehouseLive } from "./routes/warehouse.http"
import { AiTriageService } from "./services/AiTriageService"
import { AlertRuntime, AlertsService } from "./services/AlertsService"
import { AnomalyDetectionService } from "./services/AnomalyDetectionService"
import { BucketCacheService, EdgeCacheService } from "@maple/query-engine/caching"
import { CacheBackendLive } from "./lib/CacheBackendLive"
import { ErrorsService } from "./services/ErrorsService"
import { HazelOAuthService } from "./services/HazelOAuthService"
import { InvestigationService } from "./services/InvestigationService"
import { NotificationDispatcher } from "./services/NotificationDispatcher"
import { ApiKeysService } from "./services/ApiKeysService"
import { AuthService } from "./services/AuthService"
import { ApiAuthorizationLayer } from "./services/ApiAuthorizationLayer"
import { ApiAuthorizationV2Layer } from "./services/ApiAuthorizationV2Layer"
import { CloudflareAnalyticsService } from "./services/CloudflareAnalyticsService"
import { CloudflareOAuthService } from "./services/CloudflareOAuthService"
import { DashboardPersistenceService } from "./services/DashboardPersistenceService"
import { DemoService } from "./services/DemoService"
import { DigestService } from "./services/DigestService"
import { OnboardingService } from "./services/OnboardingService"
import { EmailService } from "./lib/EmailService"
import { OrgMembersService } from "./services/OrgMembersService"
import { Env } from "./lib/Env"
import { IngestAttributeMappingService } from "./services/IngestAttributeMappingService"
import { OrgIngestKeysService } from "./services/OrgIngestKeysService"
import { OrgClickHouseSettingsService } from "./services/OrgClickHouseSettingsService"
import { OrganizationService } from "./services/OrganizationService"
import { QueryEngineService } from "./services/QueryEngineService"
import { RecommendationIssueService } from "./services/RecommendationIssueService"
import { RawSqlChartService } from "@maple/query-engine/runtime"
import { PlanetScaleConnectionService } from "./services/PlanetScaleConnectionService"
import { PlanetScaleDiscoveryService } from "./services/PlanetScaleDiscoveryService"
import { PlanetScaleOAuthService } from "./services/PlanetScaleOAuthService"
import { PlanetScaleService } from "./services/PlanetScaleService"
import { ScrapeTargetsService } from "./services/ScrapeTargetsService"
import { WarehouseQueryService } from "./lib/WarehouseQueryService"
import { OAuthStateRepository } from "./services/OAuthStateRepository"
import { GithubAppClient } from "./services/vcs/vendor/github/GithubAppClient"
import { GithubConnectService } from "./services/vcs/vendor/github/GithubConnectService"
import { GithubHttp } from "./services/vcs/vendor/github/GithubHttp"
import { GithubProvider } from "./services/vcs/vendor/github/GithubProvider"
import { VcsCommitService } from "./services/vcs/VcsCommitService"
import { VcsProviderRegistry } from "./services/vcs/VcsProviderRegistry"
import { VcsRepository } from "./services/vcs/VcsRepository"
import { VcsSyncQueue } from "./services/vcs/VcsSyncQueue"

const HealthRouter = HttpRouter.use((router) => router.add("GET", "/health", HttpServerResponse.text("OK")))

const McpGetFallback = HttpRouter.use((router) =>
	router.add("GET", "/mcp", HttpServerResponse.empty({ status: 405 })),
)

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

const InfraLive = Env.layer

// PlanetScale layer composition: the OAuth grant (token lifecycle) feeds
// discovery, scrape-time auth, the org binding, and the inventory poller.
// Compose each wired layer once so memoization resolves them to single
// instances (one discovery cache, one refresh single-flight).
const PlanetScaleOAuthLive = PlanetScaleOAuthService.layer
const PlanetScaleDiscoveryLive = PlanetScaleDiscoveryService.layer.pipe(Layer.provide(PlanetScaleOAuthLive))
const ScrapeTargetsLive = ScrapeTargetsService.layer.pipe(
	Layer.provide(Layer.mergeAll(PlanetScaleDiscoveryLive, PlanetScaleOAuthLive)),
)

const CoreServicesLive = Layer.mergeAll(
	AuthService.layer,
	ApiKeysService.layer,
	CloudflareOAuthService.layer,
	DashboardPersistenceService.layer,
	HazelOAuthService.layer,
	OnboardingService.layer,
	OrgIngestKeysService.layer,
	OrgClickHouseSettingsService.layer,
	OrganizationService.layer,
	PlanetScaleOAuthLive,
	PlanetScaleDiscoveryLive,
	ScrapeTargetsLive,
	PlanetScaleConnectionService.layer.pipe(
		Layer.provide(Layer.mergeAll(ScrapeTargetsLive, PlanetScaleOAuthLive)),
	),
	PlanetScaleService.layer.pipe(Layer.provide(PlanetScaleOAuthLive)),
	IngestAttributeMappingService.layer,
).pipe(Layer.provideMerge(InfraLive))

const WarehouseQueryServiceLive = WarehouseQueryService.layer.pipe(Layer.provideMerge(CoreServicesLive))

// Serves the integration page's per-zone collection status; the poll loop itself
// runs in the alerting worker's cron, not here.
const CloudflareAnalyticsServiceLive = CloudflareAnalyticsService.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(CoreServicesLive, WarehouseQueryServiceLive)),
)

const DemoServiceLive = DemoService.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(CoreServicesLive, WarehouseQueryServiceLive)),
)

// EdgeCacheService's storage backend (Workers KV / in-memory) is injected via
// the CacheBackend port. Define the wired layer once so it memoizes to a single
// instance shared by the bucket cache and the direct edge cache.
const EdgeCacheServiceLive = EdgeCacheService.layer.pipe(Layer.provide(CacheBackendLive))

const BucketCacheServiceLive = BucketCacheService.layer.pipe(Layer.provideMerge(EdgeCacheServiceLive))

const QueryEngineServiceLive = QueryEngineService.layer.pipe(
	Layer.provideMerge(WarehouseQueryServiceLive),
	Layer.provideMerge(EdgeCacheServiceLive),
	Layer.provideMerge(BucketCacheServiceLive),
)

const EmailServiceLive = EmailService.layer.pipe(Layer.provide(Env.layer))

const OrgMembersServiceLive = OrgMembersService.layer.pipe(Layer.provide(Env.layer))

const AlertsServiceLive = AlertsService.layer.pipe(
	Layer.provideMerge(
		Layer.mergeAll(
			CoreServicesLive,
			QueryEngineServiceLive,
			AlertRuntime.layer,
			EmailServiceLive,
			OrgMembersServiceLive,
		),
	),
)

const NotificationDispatcherLive = NotificationDispatcher.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(CoreServicesLive, EmailServiceLive)),
)

const ErrorsServiceLive = ErrorsService.layer.pipe(
	Layer.provideMerge(
		Layer.mergeAll(
			CoreServicesLive,
			WarehouseQueryServiceLive,
			EdgeCacheServiceLive,
			NotificationDispatcherLive,
		),
	),
)

const RecommendationIssueServiceLive = RecommendationIssueService.layer.pipe(
	Layer.provideMerge(WarehouseQueryServiceLive),
)

// WorkerEnvironment is intentionally NOT wired here (unlike the alerting worker):
// AnomalyDetectionService reads it via Effect.serviceOption, so it degrades
// gracefully when absent and is provided at worker scope where needed.
const AnomalyDetectionServiceLive = AnomalyDetectionService.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(CoreServicesLive, WarehouseQueryServiceLive, EdgeCacheServiceLive)),
)

const AiTriageServiceLive = AiTriageService.layer.pipe(Layer.provideMerge(CoreServicesLive))

const InvestigationServiceLive = InvestigationService.layer.pipe(Layer.provideMerge(CoreServicesLive))

const DigestServiceLive = DigestService.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(InfraLive, WarehouseQueryServiceLive, EmailServiceLive)),
)

// VCS service wiring for the fetch-path worker. VcsSyncService (the sync
// orchestrator) lives only in vcs-sync-runtime.ts — not here. Database /
// WorkerEnvironment are provided at worker scope (like CoreServicesLive).
const GithubAppClientLive = GithubAppClient.layer.pipe(Layer.provide(GithubHttp.layer))
const GithubProviderLive = GithubProvider.layer.pipe(Layer.provide(GithubAppClientLive))

const VcsDataLive = Layer.mergeAll(VcsRepository.layer, OAuthStateRepository.layer, VcsSyncQueue.layer)

const VcsProviderRegistryLive = VcsProviderRegistry.layer.pipe(Layer.provide(GithubProviderLive))

const VcsServicesLive = Layer.mergeAll(
	VcsDataLive,
	VcsProviderRegistryLive,
	// OAuth connect flow — needs VcsDataLive + GithubAppClient for App-JWT installation lookup.
	GithubConnectService.layer.pipe(Layer.provide(Layer.mergeAll(VcsDataLive, GithubAppClientLive))),
	// Routed via VcsProviderRegistry so no provider module is imported directly.
	VcsCommitService.layer.pipe(Layer.provide(Layer.mergeAll(VcsDataLive, VcsProviderRegistryLive))),
).pipe(Layer.provideMerge(InfraLive))

export const MainLive = Layer.mergeAll(
	CoreServicesLive,
	CloudflareAnalyticsServiceLive,
	WarehouseQueryServiceLive,
	EdgeCacheServiceLive,
	QueryEngineServiceLive,
	AlertsServiceLive,
	AnomalyDetectionServiceLive,
	AiTriageServiceLive,
	InvestigationServiceLive,
	ErrorsServiceLive,
	RecommendationIssueServiceLive,
	DigestServiceLive,
	DemoServiceLive,
	VcsServicesLive,
	RawSqlChartService.layer,
)

const ApiRoutes = HttpApiBuilder.layer(MapleApi).pipe(
	Layer.provide(HttpAuthPublicLive),
	Layer.provide(HttpAuthLive),
	Layer.provide(Layer.mergeAll(HttpAiTriageLive, HttpAnomaliesLive, HttpChatLive, HttpInvestigationsLive)),
	Layer.provide(HttpApiKeysLive),
	Layer.provide(Layer.mergeAll(HttpBillingLive, HttpBillingPublicLive)),
	Layer.provide(HttpAlertsLive),
	Layer.provide(HttpErrorsLive),
	Layer.provide(HttpDashboardsLive),
	Layer.provide(HttpDemoLive),
	Layer.provide(HttpDigestLive),
	Layer.provide(HttpIngestAttributeMappingsLive),
	Layer.provide(HttpIngestKeysLive),
	Layer.provide(HttpIntegrationsLive),
	Layer.provide(HttpObservabilityLive),
	Layer.provide(HttpOnboardingLive),
	Layer.provide(HttpOrgClickHouseSettingsLive),
	Layer.provide(HttpOrganizationsLive),
	Layer.provide(HttpScrapeTargetsLive),
	Layer.provide(
		Layer.mergeAll(
			HttpQueryEngineLive,
			HttpRecommendationIssuesLive,
			HttpSessionReplaysLive,
			HttpWarehouseLive,
		),
	),
)

const ApiV2Routes = HttpApiBuilder.layer(MapleApiV2).pipe(
	Layer.provide(HttpV2ApiKeysLive),
	Layer.provide(V2SchemaErrorsLive),
)

export const AllRoutes = Layer.mergeAll(
	ApiRoutes,
	ApiV2Routes,
	IntegrationsCallbackRouter,
	OAuthDiscoveryRouter,
	PlanetScaleWebhookRouter,
	PrometheusScrapeProxyRouter,
	ScraperInternalRouter,
	VcsWebhookRouter,
	McpLive,
	HealthRouter,
	McpGetFallback,
	DocsRoute,
	DocsV2Route,
).pipe(
	Layer.provideMerge(
		HttpRouter.cors({
			allowedOrigins: ["*"],
			allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
			allowedHeaders: ["*"],
			// The ElectricSQL shape proxy (and its electric-* exposed headers) moved
			// to the standalone `apps/electric-sync` worker.
			exposedHeaders: ["Mcp-Session-Id"],
		}),
	),
)

export const ApiAuthLive = Layer.mergeAll(ApiAuthorizationLayer, ApiAuthorizationV2Layer).pipe(
	Layer.provideMerge(ApiKeysService.layer),
	Layer.provideMerge(Env.layer),
)

// The OTLP tracer/logger is constructed once at worker module scope and
// provided to the same runtime as the routes. This shared layer only installs
// the `TracerDisabledWhen` filter, which is a ServiceMap.Reference read by
// HttpMiddleware regardless of which Tracer is active.
export const ApiObservabilityLive = Layer.succeed(
	HttpMiddleware.TracerDisabledWhen,
	(request: { url: string; method: string }) =>
		request.url === "/health" ||
		request.method === "OPTIONS" ||
		/\.(png|ico|jpg|jpeg|gif|css|js|svg|webp|woff2?)(\?.*)?$/i.test(request.url),
)
