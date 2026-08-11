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
import { NotificationDispatcher } from "@/services/alerts/NotificationDispatcher"
import { HazelOAuthService } from "@/services/auth/HazelOAuthService"
import { DashboardPersistenceService } from "@/services/dashboards/DashboardPersistenceService"
import { ErrorActorsService } from "@/services/errors/ErrorActorsService"
import { ErrorIssueReadModelsService } from "@/services/errors/ErrorIssueReadModelsService"
import { ErrorIssueWorkflowService } from "@/services/errors/ErrorIssueWorkflowService"
import { ErrorPolicyService } from "@/services/errors/ErrorPolicyService"
import { ErrorsService } from "@/services/errors/ErrorsService"
import { InvestigationService } from "@/services/errors/InvestigationService"
import { RecommendationIssueService } from "@/services/errors/RecommendationIssueService"
import { TinybirdOrgTokenService } from "@/services/integrations/TinybirdOrgTokenService"
import { VcsProviderRegistry } from "@/services/integrations/vcs/VcsProviderRegistry"
import { VcsRepository } from "@/services/integrations/vcs/VcsRepository"
import { VcsSourceService } from "@/services/integrations/vcs/VcsSourceService"
import { GithubAppClient } from "@/services/integrations/vcs/vendor/github/GithubAppClient"
import { GithubHttp } from "@/services/integrations/vcs/vendor/github/GithubHttp"
import { GithubProvider } from "@/services/integrations/vcs/vendor/github/GithubProvider"
import { OrgClickHouseSettingsService } from "@/services/org/OrgClickHouseSettingsService"
import { OrgMembersService } from "@/services/org/OrgMembersService"
import { SetupAuditService } from "@/services/org/SetupAuditService"
import { QueryEngineService } from "@/services/warehouse/QueryEngineService"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"

const InfraLive = Env.layer

// MCP handlers use a finite service context (see runtime-requirements.ts).
// Keep this graph independent from the HTTP composition root so headless
// entrypoints do not evaluate or acquire route-only product services.
const OrgClickHouseSettingsServiceLive = OrgClickHouseSettingsService.layer.pipe(Layer.provide(InfraLive))
const TinybirdOrgTokenServiceLive = TinybirdOrgTokenService.layer.pipe(Layer.provide(InfraLive))
const HazelOAuthServiceLive = HazelOAuthService.layer.pipe(Layer.provide(InfraLive))

const WarehouseQueryServiceLive = WarehouseQueryService.layer.pipe(
	Layer.provide(Layer.mergeAll(InfraLive, OrgClickHouseSettingsServiceLive, TinybirdOrgTokenServiceLive)),
)

const EdgeCacheServiceLive = EdgeCacheService.layer.pipe(Layer.provide(CacheBackendLive))
const BucketCacheServiceLive = BucketCacheService.layer.pipe(Layer.provideMerge(EdgeCacheServiceLive))

const QueryEngineServiceLive = QueryEngineService.layer.pipe(
	Layer.provide(Layer.mergeAll(WarehouseQueryServiceLive, EdgeCacheServiceLive, BucketCacheServiceLive)),
)

const EmailServiceLive = EmailService.layer.pipe(Layer.provide(InfraLive))
const OrgMembersServiceLive = OrgMembersService.layer.pipe(Layer.provide(InfraLive))
const AlertRuntimeLive = AlertRuntime.layer

const AlertDestinationsServiceLive = AlertDestinationsService.layer.pipe(
	Layer.provide(
		Layer.mergeAll(
			InfraLive,
			AlertRuntimeLive,
			HazelOAuthServiceLive,
			EmailServiceLive,
			OrgMembersServiceLive,
		),
	),
)

const AlertReadModelsServiceLive = AlertReadModelsService.layer.pipe(
	Layer.provide(Layer.mergeAll(InfraLive, WarehouseQueryServiceLive)),
)

const AlertRulesServiceLive = AlertRulesService.layer.pipe(
	Layer.provide(Layer.mergeAll(InfraLive, AlertRuntimeLive)),
)

const AlertsServiceLive = AlertsService.layer.pipe(
	Layer.provide(
		Layer.mergeAll(
			InfraLive,
			QueryEngineServiceLive,
			WarehouseQueryServiceLive,
			AlertRuntimeLive,
			HazelOAuthServiceLive,
			EmailServiceLive,
			OrgMembersServiceLive,
			OrgClickHouseSettingsServiceLive,
			AlertDestinationsServiceLive,
			AlertReadModelsServiceLive,
			AlertRulesServiceLive,
		),
	),
)

const NotificationDispatcherLive = NotificationDispatcher.layer.pipe(
	Layer.provide(Layer.mergeAll(InfraLive, EmailServiceLive)),
)

const ErrorActorsServiceLive = ErrorActorsService.layer
const ErrorIssueWorkflowServiceLive = ErrorIssueWorkflowService.layer.pipe(
	Layer.provide(ErrorActorsServiceLive),
)
const ErrorPolicyServiceLive = ErrorPolicyService.layer
const ErrorIssueReadModelsServiceLive = ErrorIssueReadModelsService.layer.pipe(
	Layer.provide(Layer.mergeAll(WarehouseQueryServiceLive, ErrorIssueWorkflowServiceLive)),
)

const ErrorsServiceLive = ErrorsService.layer.pipe(
	Layer.provide(
		Layer.mergeAll(
			InfraLive,
			WarehouseQueryServiceLive,
			EdgeCacheServiceLive,
			NotificationDispatcherLive,
			ErrorActorsServiceLive,
			ErrorIssueReadModelsServiceLive,
			ErrorIssueWorkflowServiceLive,
			ErrorPolicyServiceLive,
		),
	),
)

const RecommendationIssueServiceLive = RecommendationIssueService.layer.pipe(
	Layer.provide(WarehouseQueryServiceLive),
)

const SetupAuditServiceLive = SetupAuditService.layer.pipe(Layer.provide(WarehouseQueryServiceLive))

const GithubAppClientLive = GithubAppClient.layer.pipe(Layer.provide(GithubHttp.layer))
const GithubProviderLive = GithubProvider.layer.pipe(Layer.provide(GithubAppClientLive))
const VcsProviderRegistryLive = VcsProviderRegistry.layer.pipe(Layer.provide(GithubProviderLive))

const VcsSourceServiceLive = VcsSourceService.layer.pipe(
	Layer.provide(
		Layer.mergeAll(VcsRepository.layer, VcsProviderRegistryLive).pipe(Layer.provideMerge(InfraLive)),
	),
)

const McpRuntimeServicesLive = Layer.mergeAll(
	AlertReadModelsServiceLive,
	AlertRulesServiceLive,
	AlertsServiceLive,
	DashboardPersistenceService.layer,
	ErrorActorsServiceLive,
	ErrorIssueReadModelsServiceLive,
	ErrorIssueWorkflowServiceLive,
	ErrorPolicyServiceLive,
	ErrorsServiceLive,
	QueryEngineServiceLive,
	RecommendationIssueServiceLive,
	SetupAuditServiceLive,
	VcsSourceServiceLive,
	WarehouseQueryServiceLive,
)

/** MCP execution root used by headless fanout agents and direct tool evals. */
export const McpServicesLive = McpToolExecutor.layer.pipe(Layer.provide(McpRuntimeServicesLive))

const InvestigationServiceLive = InvestigationService.layer.pipe(Layer.provide(InfraLive))

/** MCP execution plus diagnosis persistence for chat turns and internal RPC. */
export const InvestigationServicesLive = Layer.mergeAll(McpServicesLive, InvestigationServiceLive)
