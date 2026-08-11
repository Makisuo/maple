/**
 * Alchemy provider for Maple resources.
 *
 * Declare Maple API keys, ingest keys, dashboards, alert destinations, and
 * alert rules in your `alchemy.run.ts`, authenticated with a `maple_ak_…`
 * API key against the Maple public v2 API.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy"
 * import * as Maple from "@maple-dev/alchemy"
 * import { Effect, Layer } from "effect"
 *
 * export default Alchemy.Stack("my-app", {
 *   providers: Maple.providers(),
 * }, Effect.gen(function* () {
 *   const oncall = yield* Maple.AlertDestination("oncall", {
 *     type: "pagerduty",
 *     name: "On-call PagerDuty",
 *     integration_key: process.env.PAGERDUTY_ROUTING_KEY!,
 *   })
 *   yield* Maple.AlertRule("checkout-errors", {
 *     name: "Checkout error rate",
 *     severity: "critical",
 *     signal_type: "error_rate",
 *     comparator: "gt",
 *     threshold: 0.05,
 *     window_minutes: 5,
 *     destination_ids: [oncall.destinationId],
 *   })
 * }))
 * ```
 */

export { AlertDestination, AlertDestinationProvider, type AlertDestinationProps } from "./AlertDestination"
export {
	AlertRule,
	AlertRuleProvider,
	type AlertComparator,
	type AlertRuleProps,
	type AlertSignalType,
} from "./AlertRule"
export { ApiKey, ApiKeyProvider, type ApiKeyProps } from "./ApiKey"
export { Dashboard, DashboardProvider, type DashboardProps } from "./Dashboard"
export {
	MapleApiError,
	MapleConflictError,
	MapleNotFoundError,
	MapleUnauthorizedError,
	type MapleError,
} from "./errors"
export { IngestKeys, IngestKeysProvider, type IngestKeysProps } from "./IngestKeys"
export { listAll, MapleApi, MapleApiFromHttpClient, MapleApiLive, type MapleApiShape } from "./MapleApi"
export { DEFAULT_BASE_URL, fromEnv, MapleEnvironment } from "./MapleEnvironment"
export { Providers, providers, providersWithDependencies } from "./Providers"
