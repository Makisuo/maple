import { Effect, Layer } from "effect"
import { EdgeCacheService, MemoryCacheBackendLive } from "@maple/cache"
import { AlertsService } from "@/services/alerts/AlertsService"
import { AlertDestinationsService } from "@/services/alerts/AlertDestinationsService"
import { AlertReadModelsService } from "@/services/alerts/AlertReadModelsService"
import { AlertRulesService } from "@/services/alerts/AlertRulesService"
import { AnomalyDetectionService } from "@/services/alerts/AnomalyDetectionService"
import { ErrorsService } from "@/services/errors/ErrorsService"
import { ErrorIssueReadModelsService } from "@/services/errors/ErrorIssueReadModelsService"
import { IngestAttributeMappingService } from "@/services/org/IngestAttributeMappingService"
import { InvestigationService } from "@/services/errors/InvestigationService"
import { OrganizationService } from "@/services/org/OrganizationService"
import { LiveActivitiesService } from "@/services/push/LiveActivitiesService"
import { MobileDevicesService } from "@/services/push/MobileDevicesService"
import { OrgIngestKeysService } from "@/services/org/OrgIngestKeysService"
import { RecommendationIssueService } from "@/services/errors/RecommendationIssueService"
import { PlanetScaleConnectionService } from "@/services/integrations/PlanetScaleConnectionService"
import { PlanetScaleOAuthService } from "@/services/auth/PlanetScaleOAuthService"
import { PlanetScaleService } from "@/services/integrations/PlanetScaleService"
import { ScrapeTargetsService } from "@/services/integrations/ScrapeTargetsService"
import { SlackIntegrationService } from "@/services/integrations/SlackIntegrationService"
import { SetupAuditService } from "@/services/org/SetupAuditService"
import { ApiV2RateLimiter } from "@/services/auth/ApiV2RateLimiter"
import {
	WarehouseQueryService,
	type WarehouseQueryServiceApi,
} from "@/services/warehouse/WarehouseQueryService"
import { QueryEngineService } from "@/services/warehouse/QueryEngineService"
import { HttpV2AlertDeliveriesLive } from "./alert-deliveries.http"
import { HttpV2AlertDestinationsLive } from "./alert-destinations.http"
import { HttpV2AlertIncidentsLive } from "./alert-incidents.http"
import { HttpV2AlertRulesLive } from "./alert-rules.http"
import { HttpV2ApiKeysLive } from "./api-keys.http"
import { HttpV2AttributeMappingsLive } from "./attribute-mappings.http"
import { HttpV2DashboardsLive } from "./dashboards.http"
import { HttpV2IngestKeysLive } from "./ingest-keys.http"
import { HttpV2PlanetScaleIntegrationsLive, HttpV2SlackIntegrationsLive } from "./integrations.http"
import { HttpV2ErrorIssuesLive } from "./error-issues.http"
import { HttpV2AnomaliesLive } from "./anomalies.http"
import { HttpV2InvestigationsLive } from "./investigations.http"
import { HttpV2MobileDevicesLive } from "./mobile-devices.http"
import { HttpV2OrganizationLive } from "./organization.http"
import { HttpV2InstrumentationRecommendationsLive } from "./recommendations.http"
import { HttpV2AuditLogLive } from "./audit-log.http"
import { AuditLogService } from "@/services/audit/AuditLogService"
import { HttpV2ScrapeTargetsLive } from "./scrape-targets.http"
import { HttpV2SessionReplaysLive } from "./session-replays.http"
import { HttpV2InstrumentationAuditLive } from "./setup-audit.http"
import { HttpV2SharePublicLive } from "./share.http"
import { DashboardWidgetDataService } from "@/services/dashboards/DashboardWidgetDataService"
import {
	HttpV2EnvironmentsLive,
	HttpV2LogsLive,
	HttpV2MetricsLive,
	HttpV2ServiceMapLive,
	HttpV2ServicesLive,
	HttpV2TracesLive,
} from "./telemetry.http"
import { HttpV2WidgetSummaryLive } from "./widget-summary.http"
import { HttpV2WidgetCredentialsLive } from "./widget-credentials.http"

/**
 * Test-only support for the v2 HTTP harnesses. `HttpApiBuilder.layer(MapleApiV2)`
 * refuses to build unless *every* group registered on the api has a handler
 * layer, so each harness provides all group layers and stubs the services of
 * the groups it does not exercise.
 */

export const AllV2GroupLayersLive = Layer.mergeAll(
	HttpV2ApiKeysLive,
	HttpV2SlackIntegrationsLive,
	HttpV2PlanetScaleIntegrationsLive,
	HttpV2DashboardsLive,
	HttpV2AlertDeliveriesLive,
	HttpV2AlertRulesLive,
	HttpV2AlertDestinationsLive,
	HttpV2AlertIncidentsLive,
	HttpV2IngestKeysLive,
	HttpV2ErrorIssuesLive,
	HttpV2AttributeMappingsLive,
	// Real service, no stub: it needs only the Database every harness already provides.
	HttpV2AuditLogLive.pipe(Layer.provide(AuditLogService.layerMemory)),
	HttpV2ScrapeTargetsLive,
	HttpV2InstrumentationRecommendationsLive,
	HttpV2InstrumentationAuditLive,
	HttpV2InvestigationsLive,
	HttpV2AnomaliesLive,
	HttpV2OrganizationLive,
	// Real services, no stubs: they need only the Database every harness already
	// provides, and their own route tests are the only places that call them.
	HttpV2MobileDevicesLive.pipe(
		Layer.provide(Layer.mergeAll(MobileDevicesService.layer, LiveActivitiesService.layer)),
	),
	HttpV2SessionReplaysLive,
	HttpV2TracesLive,
	HttpV2LogsLive,
	HttpV2MetricsLive,
	HttpV2ServicesLive,
	HttpV2ServiceMapLive,
	HttpV2EnvironmentsLive,
	HttpV2WidgetSummaryLive,
	HttpV2WidgetCredentialsLive,
	// The share group's own dependencies are satisfied here rather than by every
	// harness: most v2 route tests never touch the share endpoints, and threading
	// inert services through two dozen call sites to register a group they never
	// call is churn with no assertion behind it.
	HttpV2SharePublicLive.pipe(
		Layer.provide(
			Layer.succeed(DashboardWidgetDataService, {
				variableOptions: () => Effect.succeed({}),
				resolve: () => Effect.die("share widget data is not exercised by v2 route harnesses"),
			}),
		),
		Layer.provide(
			// A directory with nobody in it, which is the self-hosted shape: the
			// preview card carries no byline and everything else about it still
			// renders. The share tests assert exactly that.
			Layer.succeed(OrganizationService, {
				retrieve: (orgId) =>
					Effect.succeed({ id: orgId, name: null, slug: null, imageUrl: null, createdAtMs: null }),
				delete: () => Effect.die("organization deletion is not exercised by v2 route harnesses"),
			}),
		),
	),
).pipe(
	// Mutation handlers across the groups record audit entries; the real service
	// needs only the Database every harness already provides.
	Layer.provide(AuditLogService.layerMemory),
)

export const ApiV2RateLimiterAllowAllLayer = Layer.succeed(ApiV2RateLimiter, {
	check: () => Effect.succeed("allowed" as const),
})

const die = () => Effect.die(new Error("This service is not available in this test harness"))

/** Synchronous stub for non-Effect-returning service methods (e.g. `asExecutor`). */
const dieSync = (): never => {
	throw new Error("This service method is not available in this test harness")
}

/**
 * Inert stubs for the Phase-1 resource services backing the investigations,
 * anomalies, and organization groups. Exported separately so harnesses that
 * bring their own warehouse/config services (which the `ConfigResourceServiceStubsLayer`
 * bundle would clash with) can still satisfy those groups.
 */
export const Phase1ResourceStubsLayer = Layer.mergeAll(
	Layer.succeed(InvestigationService, {
		listInvestigations: die,
		getInvestigation: die,
		createInvestigation: die,
		createAndStartInvestigation: die,
		restartInvestigation: die,
		updateStatus: die,
		submitDiagnosis: die,
	}),
	Layer.succeed(AnomalyDetectionService, {
		runTick: die,
		listIncidents: die,
		countIncidentsByService: die,
		getIncident: die,
		resolveIncidentManually: die,
		setIncidentIssue: die,
		getIncidentTimeseries: die,
		getSettings: die,
		updateSettings: die,
	}),
	Layer.succeed(ErrorIssueReadModelsService, {
		listIssues: die,
		countOpenIssuesByService: die,
		getIssue: die,
		listIssueIncidents: die,
		listOpenIncidents: die,
	}),
	Layer.succeed(ErrorsService, {
		listIssues: die,
		countOpenIssuesByService: die,
		getIssue: die,
		transitionIssue: die,
		claimIssue: die,
		heartbeatIssue: die,
		releaseIssue: die,
		assignIssue: die,
		setSeverity: die,
		commentOnIssue: die,
		proposeFix: die,
		listIssueEvents: die,
		registerAgent: die,
		listAgents: die,
		lookupActor: die,
		ensureUserActor: die,
		recordAnomalyLinkEvent: die,
		listIssueIncidents: die,
		listOpenIncidents: die,
		getNotificationPolicy: die,
		upsertNotificationPolicy: die,
		getEscalationPolicy: die,
		upsertEscalationPolicy: die,
		evaluateEscalationPolicy: die,
		listIssueEscalations: die,
		listRecentEscalations: die,
		runTick: die,
	}),
	Layer.succeed(OrganizationService, {
		retrieve: die,
		delete: die,
	}),
)

/** Inert WarehouseQueryService for harnesses that never touch warehouse-backed groups. */
export const makeWarehouseServiceStub = (
	overrides: Partial<WarehouseQueryServiceApi> = {},
): WarehouseQueryServiceApi => ({
	query: die,
	crossOrgQuery: die,
	rawSqlQuery: die,
	compiledQuery: die,
	compiledQueryBounded: die,
	compiledQueryWithCapabilities: die,
	compiledQueryFirst: die,
	// Not `die`: warming is best-effort and silent by contract, so a stub that
	// throws would fail a path that only tried to warm up.
	warmRoute: () => Effect.void,
	ingest: die,
	asExecutor: dieSync,
	...overrides,
})

export const WarehouseServiceStubLayer = Layer.succeed(WarehouseQueryService, makeWarehouseServiceStub())

export const TelemetryServiceStubsLayer = Layer.mergeAll(
	Layer.succeed(QueryEngineService, {
		execute: die,
		evaluate: die,
		evaluateSeries: die,
		cachedDirect: die,
	}),
)

/**
 * Inert SetupAuditService. Exported on its own (rather than only inside the config-resource bundle)
 * so harnesses that build the real config services — and would be shadowed by that bundle — can still
 * satisfy the `instrumentationAudit` group.
 */
export const SetupAuditServiceStubLayer = Layer.succeed(SetupAuditService, {
	run: die,
})

/** Inert config-resource services for harnesses that never touch those groups. */
export const ConfigResourceServiceStubsLayer = Layer.mergeAll(
	Layer.succeed(IngestAttributeMappingService, {
		list: die,
		create: die,
		update: die,
		delete: die,
	}),
	Layer.succeed(OrgIngestKeysService, {
		getOrCreate: die,
		rerollPublic: die,
		rerollPrivate: die,
		resolveIngestKey: die,
	}),
	Layer.succeed(RecommendationIssueService, {
		listReconciled: die,
		dismiss: die,
		reopen: die,
	}),
	SetupAuditServiceStubLayer,
	Layer.succeed(ScrapeTargetsService, {
		list: die,
		get: die,
		create: die,
		update: die,
		delete: die,
		deleteManaged: die,
		listAllEnabled: die,
		scrapeForCollector: die,
		recordScrapeResults: die,
		listChecks: die,
		probe: die,
	}),
	Phase1ResourceStubsLayer,
	WarehouseServiceStubLayer,
)

/**
 * Inert PlanetScale services for harnesses that never touch the PlanetScale
 * integration group. `EdgeCacheService` comes along because two of that group's
 * handlers cache through it.
 */
export const PlanetScaleServiceStubsLayer = Layer.mergeAll(
	Layer.succeed(PlanetScaleConnectionService, {
		getStatus: die,
		finalizeOrgSelection: die,
		setMetricsToken: die,
		disconnect: die,
		loadConnection: die,
		webhookConfig: die,
	}),
	Layer.succeed(PlanetScaleOAuthService, {
		startConnect: die,
		completeConnect: die,
		getValidAccessToken: die,
		listOrganizations: die,
		hasConnection: die,
		connectedByUserId: die,
		grantStatus: die,
		disconnect: die,
	}),
	Layer.succeed(PlanetScaleService, {
		pollAllOrgs: die,
		listDatabases: die,
		listEvents: die,
		queryInsights: die,
	}),
	// A real edge cache over the in-memory backend: `getOrCompute` must actually
	// round-trip so the cached wire shape is exercised, and nothing here needs KV.
	EdgeCacheService.layer.pipe(Layer.provide(MemoryCacheBackendLive)),
)

/** Inert SlackIntegrationService for harnesses that never touch the slack integration group. */
export const SlackIntegrationServiceStubLayer = Layer.succeed(
	SlackIntegrationService,
	SlackIntegrationService.of({
		startInstall: die,
		completeInstall: die,
		getStatus: die,
		uninstall: die,
		listChannels: die,
		resolveForBot: die,
		orgIdForTeam: die,
		revokeByTeamId: die,
		reconcileWorkspaces: die,
	}),
)

const alertDestinationStubs = {
	listDestinations: die,
	createDestination: die,
	updateDestination: die,
	deleteDestination: die,
	listTelegramChats: die,
	testDestination: die,
}

/** Inert destination capability for harnesses that never touch the alert destination group. */
export const AlertDestinationsServiceStubLayer = Layer.succeed(
	AlertDestinationsService,
	alertDestinationStubs,
)

const alertReadModelStubs = {
	listIncidents: die,
	getIncident: die,
	listRuleChecks: die,
	summarizeRuleChecks: die,
	listDeliveryEvents: die,
}

/** Inert read-model capability for harnesses that never touch alert history. */
export const AlertReadModelsServiceStubLayer = Layer.succeed(AlertReadModelsService, alertReadModelStubs)

const alertRuleStubs = {
	listRules: die,
	createRule: die,
	deleteRule: die,
}

/** Inert rule capability for harnesses that never touch alert-rule CRUD. */
export const AlertRulesServiceStubLayer = Layer.succeed(AlertRulesService, alertRuleStubs)

/** Inert AlertsService facade for harnesses that never touch the alert groups. */
export const AlertsServiceStubLayer = Layer.mergeAll(
	AlertDestinationsServiceStubLayer,
	AlertReadModelsServiceStubLayer,
	AlertRulesServiceStubLayer,
	Layer.succeed(AlertsService, {
		...alertDestinationStubs,
		...alertReadModelStubs,
		...alertRuleStubs,
		updateRule: die,
		testRule: die,
		previewRule: die,
		runSchedulerTick: die,
	}),
)
