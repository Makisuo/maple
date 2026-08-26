import { EdgeCacheService } from "@maple/cache"
import { BucketCacheService } from "@maple/query-engine/caching"
import { Layer } from "effect"
import { McpToolExecutor } from "@/mcp/dispatcher"
import { CacheBackendLive } from "@/platform/CacheBackendLive"
import { EmailService } from "@/platform/EmailService"
import { Env } from "@/platform/Env"
import { AlertRuntime, AlertsService } from "@/services/alerts/AlertsService"
import { AlertDestinationsService } from "@/services/alerts/AlertDestinationsService"
import { AlertReadModelsService } from "@/services/alerts/AlertReadModelsService"
import { AlertRulesService } from "@/services/alerts/AlertRulesService"
import { AnomalyDetectionService } from "@/services/alerts/AnomalyDetectionService"
import { NotificationDispatcher } from "@/services/alerts/NotificationDispatcher"
import { PlanetScaleOAuthService } from "@/services/auth/PlanetScaleOAuthService"
import { AuthService } from "@/services/auth/AuthService"
import { CliDeviceAuthService } from "@/services/auth/CliDeviceAuthService"
import { CloudflareOAuthService } from "@/services/auth/CloudflareOAuthService"
import { HazelOAuthService } from "@/services/auth/HazelOAuthService"
import { McpOAuthService } from "@/services/auth/McpOAuthService"
import { OAuthStateRepository } from "@/services/auth/OAuthStateRepository"
import { DailySpendService } from "@/services/billing/DailySpendService"
import { AutumnClient } from "@/services/billing/autumn-http"
import { StripeClient } from "@/services/billing/stripe-http"
import { DashboardPersistenceService } from "@/services/dashboards/DashboardPersistenceService"
import { SharedDashboardService } from "@/services/dashboards/SharedDashboardService"
import { DashboardWidgetDataService } from "@/services/dashboards/DashboardWidgetDataService"
import { DigestService } from "@/services/digest/DigestService"
import { AiTriageService } from "@/services/errors/AiTriageService"
import { ErrorActorsService } from "@/services/errors/ErrorActorsService"
import { ErrorIssueReadModelsService } from "@/services/errors/ErrorIssueReadModelsService"
import { ErrorIssueWorkflowService } from "@/services/errors/ErrorIssueWorkflowService"
import { PullRequestLookupLive } from "@/services/errors/pull-request-lookup-live"
import { IssueFixVerificationService } from "@/services/errors/IssueFixVerificationService"
import { ErrorPolicyService } from "@/services/errors/ErrorPolicyService"
import { ErrorsService } from "@/services/errors/ErrorsService"
import { InvestigationService } from "@/services/errors/InvestigationService"
import { RecommendationIssueService } from "@/services/errors/RecommendationIssueService"
import { CloudflareAnalyticsService } from "@/services/integrations/CloudflareAnalyticsService"
import { PlanetScaleConnectionService } from "@/services/integrations/PlanetScaleConnectionService"
import { PlanetScaleDiscoveryService } from "@/services/integrations/PlanetScaleDiscoveryService"
import { PlanetScaleService } from "@/services/integrations/PlanetScaleService"
import { ScrapeTargetsService } from "@/services/integrations/ScrapeTargetsService"
import { SlackIntegrationService } from "@/services/integrations/SlackIntegrationService"
import { TinybirdOrgTokenService } from "@/services/integrations/TinybirdOrgTokenService"
import { PlanetScaleWebhookQueue } from "@/services/integrations/planetscale/PlanetScaleWebhookQueue"
import { VcsCommitService } from "@/services/integrations/vcs/VcsCommitService"
import { VcsProviderRegistry } from "@/services/integrations/vcs/VcsProviderRegistry"
import { VcsRepository } from "@/services/integrations/vcs/VcsRepository"
import { VcsSourceService } from "@/services/integrations/vcs/VcsSourceService"
import { VcsSyncQueue } from "@/services/integrations/vcs/VcsSyncQueue"
import { GithubAppClient } from "@/services/integrations/vcs/vendor/github/GithubAppClient"
import { GithubConnectService } from "@/services/integrations/vcs/vendor/github/GithubConnectService"
import { GithubHttp } from "@/services/integrations/vcs/vendor/github/GithubHttp"
import { GithubProvider } from "@/services/integrations/vcs/vendor/github/GithubProvider"
import { ApiKeysService } from "@/services/org/ApiKeysService"
import { DemoService } from "@/services/org/DemoService"
import { IngestAttributeMappingService } from "@/services/org/IngestAttributeMappingService"
import { OnboardingService } from "@/services/org/OnboardingService"
import { OrgClickHouseSettingsService } from "@/services/org/OrgClickHouseSettingsService"
import { OrgIngestKeysService } from "@/services/org/OrgIngestKeysService"
import { OrgMembersService } from "@/services/org/OrgMembersService"
import { OrganizationService } from "@/services/org/OrganizationService"
import { LiveActivitiesService } from "@/services/push/LiveActivitiesService"
import { MobileDevicesService } from "@/services/push/MobileDevicesService"
import { SetupAuditService } from "@/services/org/SetupAuditService"
import { ProductEventsService } from "@/services/product-events/ProductEventsService"
import { QueryEngineService } from "@/services/warehouse/QueryEngineService"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"

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

const EdgeCacheServiceLive = EdgeCacheService.layer.pipe(Layer.provide(CacheBackendLive))

const CoreServicesLive = Layer.mergeAll(
	AuthService.layer,
	ApiKeysService.layer,
	CliDeviceAuthService.layer,
	McpOAuthService.layer,
	CloudflareOAuthService.layer,
	DashboardPersistenceService.layer,
	SharedDashboardService.layer,
	HazelOAuthService.layer,
	OnboardingService.layer,
	OrgIngestKeysService.layer,
	OrgClickHouseSettingsService.layer.pipe(Layer.provide(EdgeCacheServiceLive)),
	TinybirdOrgTokenService.layer,
	OrganizationService.layer,
	MobileDevicesService.layer,
	LiveActivitiesService.layer,
	PlanetScaleOAuthLive,
	PlanetScaleDiscoveryLive,
	PlanetScaleWebhookQueue.layer,
	ScrapeTargetsLive,
	PlanetScaleConnectionService.layer.pipe(
		Layer.provide(Layer.mergeAll(ScrapeTargetsLive, PlanetScaleDiscoveryLive, PlanetScaleOAuthLive)),
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

const BucketCacheServiceLive = BucketCacheService.layer.pipe(Layer.provideMerge(EdgeCacheServiceLive))

const QueryEngineServiceLive = QueryEngineService.layer.pipe(
	Layer.provideMerge(WarehouseQueryServiceLive),
	Layer.provideMerge(EdgeCacheServiceLive),
	Layer.provideMerge(BucketCacheServiceLive),
)

// Server-side widget data for shared dashboards. Needs both the query engine
// (query sets, caching) and the warehouse (raw SQL), so it composes after them
// rather than sitting in CoreServicesLive.
const DashboardWidgetDataServiceLive = DashboardWidgetDataService.layer.pipe(
	Layer.provideMerge(QueryEngineServiceLive),
)

const EmailServiceLive = EmailService.layer.pipe(Layer.provide(Env.layer))

const OrgMembersServiceLive = OrgMembersService.layer.pipe(Layer.provide(Env.layer))

const AlertRuntimeLive = AlertRuntime.layer

const AlertDestinationsServiceLive = AlertDestinationsService.layer.pipe(
	Layer.provide(
		Layer.mergeAll(CoreServicesLive, AlertRuntimeLive, EmailServiceLive, OrgMembersServiceLive),
	),
)

const AlertReadModelsServiceLive = AlertReadModelsService.layer.pipe(
	Layer.provide(Layer.mergeAll(CoreServicesLive, WarehouseQueryServiceLive)),
)

const AlertRulesServiceLive = AlertRulesService.layer.pipe(
	Layer.provide(Layer.mergeAll(CoreServicesLive, AlertRuntimeLive)),
)

const AlertsServiceLive = AlertsService.layer.pipe(
	Layer.provideMerge(
		Layer.mergeAll(
			CoreServicesLive,
			QueryEngineServiceLive,
			AlertRuntimeLive,
			EmailServiceLive,
			OrgMembersServiceLive,
			AlertDestinationsServiceLive,
			AlertReadModelsServiceLive,
			AlertRulesServiceLive,
		),
	),
)

const NotificationDispatcherLive = NotificationDispatcher.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(CoreServicesLive, EmailServiceLive)),
)

const ErrorActorsServiceLive = ErrorActorsService.layer
const ErrorIssueWorkflowServiceLive = ErrorIssueWorkflowService.layer.pipe(
	Layer.provideMerge(ErrorActorsServiceLive),
)
const ErrorPolicyServiceLive = ErrorPolicyService.layer
const ErrorIssueReadModelsServiceLive = ErrorIssueReadModelsService.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(WarehouseQueryServiceLive, ErrorIssueWorkflowServiceLive)),
)

// Slack integration: OAuth install/callback, status, channels, uninstall, and
// the internal bot-resolve endpoint. Needs ApiKeysService (mint the bot key) +
// OAuthStateRepository (CSRF state) on top of the core services.
const SlackIntegrationServiceLive = SlackIntegrationService.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(CoreServicesLive, OAuthStateRepository.layer)),
)

// VCS service wiring for the fetch-path worker. VcsSyncService (the sync
// orchestrator) lives only in vcs-sync-runtime.ts — not here. Database /
// WorkerEnvironment are provided at worker scope (like CoreServicesLive).
const GithubAppClientLive = GithubAppClient.layer.pipe(Layer.provide(GithubHttp.layer))
const GithubProviderLive = GithubProvider.layer.pipe(Layer.provide(GithubAppClientLive))

const VcsDataLive = Layer.mergeAll(VcsRepository.layer, OAuthStateRepository.layer, VcsSyncQueue.layer)

const VcsProviderRegistryLive = VcsProviderRegistry.layer.pipe(Layer.provide(GithubProviderLive))

// Named rather than inlined into `VcsServicesLive` below: the errors side needs
// the same instance to hydrate a pull-request link.
const VcsSourceServiceLive = VcsSourceService.layer.pipe(
	Layer.provide(Layer.mergeAll(VcsDataLive, VcsProviderRegistryLive)),
)

// Lets a pull-request link be attached with the PR's real title and state, and
// lets one attached to an already-merged PR open its verification window — a
// webhook for a merge that happened in the past is never coming.
const PullRequestLookupServiceLive = PullRequestLookupLive.pipe(
	Layer.provide(VcsSourceServiceLive.pipe(Layer.provideMerge(InfraLive))),
)

// Issue⇄pull-request links and post-merge fix verification. Depends only on the
// issue kernel (workflow + actors), never on the VCS services: the webhook
// reaches it through `PullRequestEventSink`, which points the other way.
const IssueFixVerificationServiceLive = IssueFixVerificationService.layer.pipe(
	Layer.provide(PullRequestLookupServiceLive),
	Layer.provideMerge(
		Layer.mergeAll(CoreServicesLive, ErrorActorsServiceLive, ErrorIssueWorkflowServiceLive),
	),
)

const ErrorsServiceLive = ErrorsService.layer.pipe(
	Layer.provideMerge(
		Layer.mergeAll(
			CoreServicesLive,
			WarehouseQueryServiceLive,
			EdgeCacheServiceLive,
			NotificationDispatcherLive,
			ErrorActorsServiceLive,
			ErrorIssueReadModelsServiceLive,
			ErrorIssueWorkflowServiceLive,
			ErrorPolicyServiceLive,
			// Lets `propose_fix` turn its `pr_url` into a durable link.
			IssueFixVerificationServiceLive,
		),
	),
)

const RecommendationIssueServiceLive = RecommendationIssueService.layer.pipe(
	Layer.provideMerge(WarehouseQueryServiceLive),
)

const SetupAuditServiceLive = SetupAuditService.layer.pipe(Layer.provideMerge(WarehouseQueryServiceLive))

// WorkerEnvironment is intentionally NOT wired here (unlike the alerting worker):
// AnomalyDetectionService reads it via Effect.serviceOption, so it degrades
// gracefully when absent and is provided at worker scope where needed.
const AnomalyDetectionServiceLive = AnomalyDetectionService.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(CoreServicesLive, WarehouseQueryServiceLive, EdgeCacheServiceLive)),
)

const AiTriageServiceLive = AiTriageService.layer.pipe(Layer.provideMerge(CoreServicesLive))

const InvestigationServiceLive = InvestigationService.layer.pipe(Layer.provide(InfraLive))

const DigestServiceLive = DigestService.layer.pipe(
	Layer.provideMerge(
		Layer.mergeAll(InfraLive, WarehouseQueryServiceLive, EdgeCacheServiceLive, EmailServiceLive),
	),
)

const VcsServicesLive = Layer.mergeAll(
	VcsDataLive,
	VcsProviderRegistryLive,
	// OAuth connect flow — needs VcsDataLive + GithubAppClient for App-JWT installation lookup.
	GithubConnectService.layer.pipe(Layer.provide(Layer.mergeAll(VcsDataLive, GithubAppClientLive))),
	// Routed via VcsProviderRegistry so no provider module is imported directly.
	VcsCommitService.layer.pipe(Layer.provide(Layer.mergeAll(VcsDataLive, VcsProviderRegistryLive))),
	VcsSourceServiceLive,
).pipe(Layer.provideMerge(InfraLive))

// Warehouse-backed daily volume for the billing spend chart.
const DailySpendServiceLive = DailySpendService.layer.pipe(Layer.provideMerge(WarehouseQueryServiceLive))

// Autumn's REST surface for the billing routes. Only needs Env — the HttpClient
// comes from its own `Layer.provide(FetchHttpClient.layer)` — and it builds fine
// with no `AUTUMN_SECRET_KEY` (each call then fails as "Billing is not
// configured"), so an unconfigured local worker still boots.
const AutumnClientLive = AutumnClient.layer.pipe(Layer.provide(InfraLive))

// Stripe's customer + tax-ID routes for the billing-details card. Same shape
// and the same boot posture as AutumnClient: no `STRIPE_SECRET_KEY` means each
// call fails as "not configured", never the layer.
const StripeClientLive = StripeClient.layer.pipe(Layer.provide(InfraLive))

// Server-side product events (signup/plan funnel) — the Clerk/Autumn webhook
// receivers and the billing `attach` route emit through it. Builds without an
// ingest key (every `track` is then a logged no-op).
const ProductEventsServiceLive = ProductEventsService.layer.pipe(Layer.provide(InfraLive))

const MainServicesLive = Layer.mergeAll(
	CoreServicesLive,
	AutumnClientLive,
	StripeClientLive,
	ProductEventsServiceLive,
	DailySpendServiceLive,
	CloudflareAnalyticsServiceLive,
	WarehouseQueryServiceLive,
	EdgeCacheServiceLive,
	QueryEngineServiceLive,
	DashboardWidgetDataServiceLive,
	AlertDestinationsServiceLive,
	AlertReadModelsServiceLive,
	AlertRulesServiceLive,
	AlertsServiceLive,
	AnomalyDetectionServiceLive,
	AiTriageServiceLive,
	InvestigationServiceLive,
	ErrorIssueWorkflowServiceLive,
	ErrorPolicyServiceLive,
	ErrorIssueReadModelsServiceLive,
	ErrorsServiceLive,
	IssueFixVerificationServiceLive,
	RecommendationIssueServiceLive,
	SetupAuditServiceLive,
	DigestServiceLive,
	DemoServiceLive,
	VcsServicesLive,
	SlackIntegrationServiceLive,
)

/**
 * Complete service graph for the HTTP worker.
 *
 * HTTP exposes every product surface plus MCP, so this is intentionally the
 * broadest root. Non-HTTP entrypoints use the smaller roots in
 * `mcp-service-graph.ts` instead of importing or acquiring route-only services
 * such as billing, demo, digest, OAuth, anomaly detection, and Slack integration.
 */
export const HttpServicesLive = McpToolExecutor.layer.pipe(Layer.provideMerge(MainServicesLive))
