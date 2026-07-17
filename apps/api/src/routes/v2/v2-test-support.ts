import { Effect, Layer } from "effect"
import { AlertsService } from "../../services/AlertsService"
import { HttpV2AlertDestinationsLive } from "./alert-destinations.http"
import { HttpV2AlertIncidentsLive } from "./alert-incidents.http"
import { HttpV2AlertRulesLive } from "./alert-rules.http"
import { HttpV2ApiKeysLive } from "./api-keys.http"
import { HttpV2DashboardsLive } from "./dashboards.http"

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
)

const die = () => Effect.die(new Error("AlertsService is not available in this test harness"))

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
