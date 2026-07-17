import { Effect, Layer } from "effect"
import { AlertsService } from "../../services/AlertsService"
import { IngestAttributeMappingService } from "../../services/IngestAttributeMappingService"
import { OrgIngestKeysService } from "../../services/OrgIngestKeysService"
import { RecommendationIssueService } from "../../services/RecommendationIssueService"
import { ScrapeTargetsService } from "../../services/ScrapeTargetsService"
import { HttpV2AlertDestinationsLive } from "./alert-destinations.http"
import { HttpV2AlertIncidentsLive } from "./alert-incidents.http"
import { HttpV2AlertRulesLive } from "./alert-rules.http"
import { HttpV2ApiKeysLive } from "./api-keys.http"
import { HttpV2AttributeMappingsLive } from "./attribute-mappings.http"
import { HttpV2DashboardsLive } from "./dashboards.http"
import { HttpV2IngestKeysLive } from "./ingest-keys.http"
import { HttpV2RecommendationsLive } from "./recommendations.http"
import { HttpV2ScrapeTargetsLive } from "./scrape-targets.http"

/**
 * Test-only support for the v2 HTTP harnesses. `HttpApiBuilder.layer(MapleApiV2)`
 * refuses to build unless *every* group registered on the api has a handler
 * layer, so each harness provides all group layers and stubs the services of
 * the groups it does not exercise.
 */

export const AllV2GroupLayersLive = Layer.mergeAll(
	HttpV2ApiKeysLive,
	HttpV2DashboardsLive,
	HttpV2AlertRulesLive,
	HttpV2AlertDestinationsLive,
	HttpV2AlertIncidentsLive,
	HttpV2IngestKeysLive,
	HttpV2AttributeMappingsLive,
	HttpV2ScrapeTargetsLive,
	HttpV2RecommendationsLive,
)

const die = () => Effect.die(new Error("AlertsService is not available in this test harness"))

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
	listRuleChecks: die,
	listDeliveryEvents: die,
	runSchedulerTick: die,
})
