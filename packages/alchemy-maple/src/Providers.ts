import * as Layer from "effect/Layer"
import { FetchHttpClient } from "effect/unstable/http"
import * as Provider from "alchemy/Provider"
import { AlertDestination, AlertDestinationProvider } from "./AlertDestination"
import { AlertRule, AlertRuleProvider } from "./AlertRule"
import { ApiKey, ApiKeyProvider } from "./ApiKey"
import { Dashboard, DashboardProvider } from "./Dashboard"
import { IngestKeys, IngestKeysProvider } from "./IngestKeys"
import { MapleApiFromHttpClient } from "./MapleApi"
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
 * Credentials come from `MAPLE_API_KEY` / `MAPLE_API_URL` and requests use the
 * runtime's global `fetch`. Use {@link providersWithDependencies} to supply a
 * different environment or HTTP client.
 */
export const providers = () =>
	providersWithDependencies().pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(MapleEnvironment.fromEnv()),
	)

/**
 * Construct the Maple provider collection without choosing configuration or
 * transport. The returned layer requires both
 * {@link MapleEnvironment.MapleEnvironment} and Effect's `HttpClient` service,
 * so layers supplied by the caller are the services the providers actually
 * capture. Alchemy supplies the Stack and Stage services used for rule ownership.
 *
 * @example
 * ```typescript
 * const mapleProviders = Maple.providersWithDependencies().pipe(
 *   Layer.provide(myMapleEnvironment),
 *   Layer.provide(myHttpClient),
 * )
 * ```
 */
export const providersWithDependencies = () =>
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
		Layer.provide(MapleApiFromHttpClient()),
		Layer.orDie,
	)
