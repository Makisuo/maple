import { Effect, Layer } from "effect"
import { AlertsService } from "@/services/alerts/AlertsService"
import { AnomalyDetectionService } from "@/services/alerts/AnomalyDetectionService"
import { ErrorsService } from "@/services/errors/ErrorsService"
import { IngestAttributeMappingService } from "@/services/org/IngestAttributeMappingService"
import { InvestigationService } from "@/services/errors/InvestigationService"
import { OrganizationService } from "@/services/org/OrganizationService"
import { OrgIngestKeysService } from "@/services/org/OrgIngestKeysService"
import { RecommendationIssueService } from "@/services/errors/RecommendationIssueService"
import { ScrapeTargetsService } from "@/services/integrations/ScrapeTargetsService"
import { SlackIntegrationService } from "@/services/integrations/SlackIntegrationService"
import { SetupAuditService } from "@/services/org/SetupAuditService"
import { ApiV2RateLimiter } from "@/services/auth/ApiV2RateLimiter"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import { QueryEngineService } from "@/services/warehouse/QueryEngineService"
import { HttpV2AlertDeliveriesLive } from "./alert-deliveries.http"
import { HttpV2AlertDestinationsLive } from "./alert-destinations.http"
import { HttpV2AlertIncidentsLive } from "./alert-incidents.http"
import { HttpV2AlertRulesLive } from "./alert-rules.http"
import { HttpV2ApiKeysLive } from "./api-keys.http"
import { HttpV2AttributeMappingsLive } from "./attribute-mappings.http"
import { HttpV2DashboardsLive } from "./dashboards.http"
import { HttpV2IngestKeysLive } from "./ingest-keys.http"
import { HttpV2SlackIntegrationsLive } from "./integrations.http"
import { HttpV2ErrorIssuesLive } from "./error-issues.http"
import { HttpV2AnomaliesLive } from "./anomalies.http"
import { HttpV2InvestigationsLive } from "./investigations.http"
import { HttpV2OrganizationLive } from "./organization.http"
import { HttpV2InstrumentationRecommendationsLive } from "./recommendations.http"
import { HttpV2ScrapeTargetsLive } from "./scrape-targets.http"
import { HttpV2SessionReplaysLive } from "./session-replays.http"
import { HttpV2InstrumentationAuditLive } from "./setup-audit.http"
import {
	HttpV2LogsLive,
	HttpV2MetricsLive,
	HttpV2ServiceMapLive,
	HttpV2ServicesLive,
	HttpV2TracesLive,
} from "./telemetry.http"

/**
 * Test-only support for the v2 HTTP harnesses. `HttpApiBuilder.layer(MapleApiV2)`
 * refuses to build unless *every* group registered on the api has a handler
 * layer, so each harness provides all group layers and stubs the services of
 * the groups it does not exercise.
 */

export const AllV2GroupLayersLive = Layer.mergeAll(
	HttpV2ApiKeysLive,
	HttpV2SlackIntegrationsLive,
	HttpV2DashboardsLive,
	HttpV2AlertDeliveriesLive,
	HttpV2AlertRulesLive,
	HttpV2AlertDestinationsLive,
	HttpV2AlertIncidentsLive,
	HttpV2IngestKeysLive,
	HttpV2ErrorIssuesLive,
	HttpV2AttributeMappingsLive,
	HttpV2ScrapeTargetsLive,
	HttpV2InstrumentationRecommendationsLive,
	HttpV2InstrumentationAuditLive,
	HttpV2InvestigationsLive,
	HttpV2AnomaliesLive,
	HttpV2OrganizationLive,
	HttpV2SessionReplaysLive,
	HttpV2TracesLive,
	HttpV2LogsLive,
	HttpV2MetricsLive,
	HttpV2ServicesLive,
	HttpV2ServiceMapLive,
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
		getIncident: die,
		resolveIncidentManually: die,
		setIncidentIssue: die,
		getIncidentTimeseries: die,
		getSettings: die,
		updateSettings: die,
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
export const WarehouseServiceStubLayer = Layer.succeed(WarehouseQueryService, {
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
})

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
export const SetupAuditServiceStubLayer = Layer.succeed(SetupAuditService, { run: die })

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
		listAllEnabled: die,
		scrapeForCollector: die,
		recordScrapeResults: die,
		listChecks: die,
		probe: die,
	}),
	Phase1ResourceStubsLayer,
	WarehouseServiceStubLayer,
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
		revokeByTeamId: die,
		reconcileWorkspaces: die,
	}),
)

/** Inert AlertsService for harnesses that never touch the alert groups. */
export const AlertsServiceStubLayer = Layer.succeed(AlertsService, {
	listDestinations: die,
	createDestination: die,
	updateDestination: die,
	deleteDestination: die,
	testDestination: die,
	listRules: die,
	createRule: die,
	updateRule: die,
	deleteRule: die,
	testRule: die,
	previewRule: die,
	listIncidents: die,
	getIncident: die,
	listRuleChecks: die,
	summarizeRuleChecks: die,
	listDeliveryEvents: die,
	runSchedulerTick: die,
})
