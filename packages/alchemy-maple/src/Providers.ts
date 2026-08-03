import * as Layer from "effect/Layer"
import * as Provider from "alchemy/Provider"
import { AlertDestination, AlertDestinationProvider } from "./AlertDestination"
import { AlertRule, AlertRuleProvider } from "./AlertRule"
import { ApiKey, ApiKeyProvider } from "./ApiKey"
import { Dashboard, DashboardProvider } from "./Dashboard"
import { IngestKeys, IngestKeysProvider } from "./IngestKeys"
import { MapleApiLive } from "./MapleApi"
import * as MapleEnvironment from "./MapleEnvironment"

export class Providers extends Provider.ProviderCollection<Providers>()("Maple") {}

/**
 * The Maple provider collection. Merge it into your stack's `providers`
 * layer alongside any others:
 *
 * ```typescript
 * export default Alchemy.Stack("my-app", {
 *   providers: Layer.mergeAll(Cloudflare.providers(), Maple.providers()),
 * }, Effect.gen(function* () { ... }))
 * ```
 *
 * Credentials come from `MAPLE_API_KEY` / `MAPLE_API_URL` by default; provide
 * your own {@link MapleEnvironment.MapleEnvironment} layer to override.
 */
export const providers = () =>
	Layer.effect(
		Providers,
		Provider.collection([ApiKey, Dashboard, AlertDestination, AlertRule, IngestKeys]),
	).pipe(
		Layer.provide(
			Layer.mergeAll(
				ApiKeyProvider(),
				DashboardProvider(),
				AlertDestinationProvider(),
				AlertRuleProvider(),
				IngestKeysProvider(),
			),
		),
		Layer.provide(MapleApiLive()),
		Layer.provide(MapleEnvironment.fromEnv()),
		Layer.orDie,
	)
