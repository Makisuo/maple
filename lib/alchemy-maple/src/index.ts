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
 *   const slack = yield* Maple.AlertDestination("oncall", {
 *     type: "slack",
 *     name: "On-call Slack",
 *     webhook_url: process.env.SLACK_WEBHOOK_URL!,
 *   })
 *   yield* Maple.AlertRule("checkout-errors", {
 *     name: "Checkout error rate",
 *     severity: "critical",
 *     signal_type: "error_rate",
 *     comparator: "gt",
 *     threshold: 0.05,
 *     window_minutes: 5,
 *     destination_ids: [slack.destinationId],
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
export { listAll, MapleApi, MapleApiLive, type MapleApiShape } from "./MapleApi"
export { DEFAULT_BASE_URL, fromEnv, MapleEnvironment } from "./MapleEnvironment"
export { Providers, providers } from "./Providers"
