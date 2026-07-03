import { MapleApi } from "@maple/domain/http"
import { Layer } from "effect"
import { HttpMiddleware, HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi"
import { McpLive } from "./mcp/app"
import { HttpBillingLive, HttpBillingPublicLive } from "./routes/billing.http"
import { BillingWebhookRouter } from "./routes/billing-webhook.http"
import { HttpAiTriageLive } from "./routes/ai-triage.http"
import { HttpAlertsLive } from "./routes/alerts.http"
import { HttpAnomaliesLive } from "./routes/anomalies.http"
import { HttpErrorsLive } from "./routes/errors.http"
import { HttpApiKeysLive } from "./routes/api-keys.http"
import { HttpAuthLive, HttpAuthPublicLive } from "./routes/auth.http"
import { HttpChatLive } from "./routes/chat.http"
import { HttpCloudflareLogpushLive } from "./routes/cloudflare-logpush.http"
import { HttpDashboardsLive } from "./routes/dashboards.http"
import { HttpDemoLive } from "./routes/demo.http"
import { HttpDigestLive } from "./routes/digest.http"
import { HttpIntegrationsLive, IntegrationsCallbackRouter } from "./routes/integrations.http"
import { HttpInvestigationsLive } from "./routes/investigations.http"
import { HttpInvestigationsInternalLive } from "./routes/investigations-internal.http"
import { HttpIngestAttributeMappingsLive } from "./routes/ingest-attribute-mappings.http"
import { HttpIngestKeysLive } from "./routes/ingest-keys.http"
import { HttpObservabilityLive } from "./routes/observability.http"
import { HttpOnboardingLive } from "./routes/onboarding.http"
import { OAuthDiscoveryRouter } from "./routes/oauth-discovery.http"
import { HttpOrgClickHouseSettingsLive } from "./routes/org-clickhouse-settings.http"
import { HttpOrganizationsLive } from "./routes/organizations.http"
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
import { BillingSuspensionService } from "./services/BillingSuspensionService"
import { BucketCacheService, EdgeCacheService } from "@maple/query-engine/caching"
import { CacheBackendLive } from "./lib/CacheBackendLive"
import { ErrorsService } from "./services/ErrorsService"
import { HazelOAuthService } from "./services/HazelOAuthService"
import { InvestigationService } from "./services/InvestigationService"
import { NotificationDispatcher } from "./services/NotificationDispatcher"
import { ApiKeysService } from "./services/ApiKeysService"
import { AuthService } from "./services/AuthService"
import { ApiAuthorizationLayer } from "./services/ApiAuthorizationLayer"
import { InternalServiceAuthorizationLayer } from "./services/InternalServiceAuthorizationLayer"
import { CloudflareLogpushService } from "./services/CloudflareLogpushService"
import { DashboardPersistenceService } from "./services/DashboardPersistenceService"
import { DemoService } from "./services/DemoService"
import { DigestService } from "./services/DigestService"
import { OnboardingService } from "./services/OnboardingService"
import { EmailService } from "./lib/EmailService"
import { Env } from "./lib/Env"
import { IngestAttributeMappingService } from "./services/IngestAttributeMappingService"
import { OrgIngestKeysService } from "./services/OrgIngestKeysService"
import { OrgClickHouseSettingsService } from "./services/OrgClickHouseSettingsService"
import { OrganizationService } from "./services/OrganizationService"
import { QueryEngineService } from "./services/QueryEngineService"
import { RecommendationIssueService } from "./services/RecommendationIssueService"
import { RawSqlChartService } from "@maple/query-engine/runtime"
import { PlanetScaleDiscoveryService } from "./services/PlanetScaleDiscoveryService"
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

const InfraLive = Env.layer

const CoreServicesLive = Layer.mergeAll(
	AuthService.layer,
	ApiKeysService.layer,
	CloudflareLogpushService.layer,
	DashboardPersistenceService.layer,
	HazelOAuthService.layer,
	OnboardingService.layer,
	OrgIngestKeysService.layer,
	OrgClickHouseSettingsService.layer,
	OrganizationService.layer,
	BillingSuspensionService.layer,
	// Shared with ScrapeTargetsService via layer memoization so the proxy and
	// the internal target list resolve sub-targets from one discovery cache.
	PlanetScaleDiscoveryService.layer,
	ScrapeTargetsService.layer.pipe(Layer.provide(PlanetScaleDiscoveryService.layer)),
	IngestAttributeMappingService.layer,
).pipe(Layer.provideMerge(InfraLive))

const WarehouseQueryServiceLive = WarehouseQueryService.layer.pipe(Layer.provideMerge(CoreServicesLive))

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

const AlertsServiceLive = AlertsService.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(CoreServicesLive, QueryEngineServiceLive, AlertRuntime.layer)),
)

const NotificationDispatcherLive = NotificationDispatcher.layer.pipe(Layer.provideMerge(CoreServicesLive))

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

const AnomalyDetectionServiceLive = AnomalyDetectionService.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(CoreServicesLive, WarehouseQueryServiceLive, EdgeCacheServiceLive)),
)

const AiTriageServiceLive = AiTriageService.layer.pipe(Layer.provideMerge(CoreServicesLive))

const InvestigationServiceLive = InvestigationService.layer.pipe(Layer.provideMerge(CoreServicesLive))

const EmailServiceLive = EmailService.layer.pipe(Layer.provide(Env.layer))

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
	Layer.provide(
		Layer.mergeAll(
			HttpAiTriageLive,
			HttpAnomaliesLive,
			HttpChatLive,
			HttpInvestigationsLive,
			HttpInvestigationsInternalLive,
		),
	),
	Layer.provide(HttpApiKeysLive),
	Layer.provide(Layer.mergeAll(HttpBillingLive, HttpBillingPublicLive)),
	Layer.provide(HttpAlertsLive),
	Layer.provide(HttpErrorsLive),
	Layer.provide(HttpCloudflareLogpushLive),
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

export const AllRoutes = Layer.mergeAll(
	ApiRoutes,
	IntegrationsCallbackRouter,
	OAuthDiscoveryRouter,
	PrometheusScrapeProxyRouter,
	ScraperInternalRouter,
	VcsWebhookRouter,
	BillingWebhookRouter,
	McpLive,
	HealthRouter,
	McpGetFallback,
	DocsRoute,
).pipe(
	Layer.provideMerge(
		HttpRouter.cors({
			allowedOrigins: ["*"],
			allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
			allowedHeaders: ["*"],
			exposedHeaders: ["Mcp-Session-Id"],
		}),
	),
)

export const ApiAuthLive = ApiAuthorizationLayer.pipe(
	Layer.provideMerge(ApiKeysService.layer),
	Layer.provideMerge(Env.layer),
)

// Internal-service-token middleware (the chat-flue `submit_diagnosis` write).
// Mirrors ApiAuthLive; AuthService/ApiKeysService/Env are layer-memoized, so this
// shares instances with MainLive rather than constructing duplicates.
export const InternalServiceAuthLive = InternalServiceAuthorizationLayer.pipe(
	Layer.provideMerge(ApiKeysService.layer),
	Layer.provideMerge(AuthService.layer),
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
