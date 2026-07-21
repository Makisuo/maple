import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Redacted from "effect/Redacted"

/**
 * Connection settings for the Maple public v2 API.
 *
 * Every Maple provider resolves its base URL and credential from this
 * service. `Maple.providers()` wires it from the environment by default
 * ({@link fromEnv}); provide your own layer to point at a different
 * deployment or to source the key from elsewhere.
 */
export class MapleEnvironment extends Context.Service<
	MapleEnvironment,
	{
		/** Base URL of the Maple API, without a trailing slash. */
		readonly baseUrl: string
		/** A Maple API key (`maple_ak_…`) with the scopes the declared resources need. */
		readonly apiKey: Redacted.Redacted<string>
	}
>()("Maple::Environment") {}

export const DEFAULT_BASE_URL = "https://api.maple.dev"

/**
 * Resolve the Maple environment from process env:
 *
 * - `MAPLE_API_KEY` (required) — a `maple_ak_…` API key. Mutating API keys,
 *   ingest keys, and alert rules/destinations requires a key backed by an
 *   org-admin; dashboards need the `dashboards:write` scope.
 * - `MAPLE_API_URL` (optional) — defaults to `https://api.maple.dev`.
 */
export const fromEnv = () =>
	Layer.effect(
		MapleEnvironment,
		Effect.gen(function* () {
			const apiKey = yield* Config.redacted("MAPLE_API_KEY")
			const baseUrl = yield* Config.string("MAPLE_API_URL").pipe(
				Config.withDefault(DEFAULT_BASE_URL),
			)
			return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey }
		}).pipe(Effect.orDie),
	)
