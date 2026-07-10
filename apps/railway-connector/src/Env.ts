import { Config, Context, Effect, Layer, Redacted } from "effect"

export interface RailwayConnectorEnvShape {
	/** Base URL of the Maple API, e.g. `https://api.maple.dev`. */
	readonly MAPLE_API_URL: string
	/** Shared internal bearer for the `/api/internal/railway-*` endpoints. */
	readonly SD_INTERNAL_TOKEN: Redacted.Redacted<string>
	/**
	 * Base URL of the Maple ingest gateway, e.g. `https://ingest.maple.dev`.
	 * Pulled logs/metrics are sent here as OTLP/JSON with each org's public
	 * ingest key so they get billed and warehouse-routed per org.
	 */
	readonly MAPLE_INGEST_URL: string
	/** Railway public GraphQL API over HTTP (metrics query, discovery). */
	readonly RAILWAY_GRAPHQL_HTTP_URL: string
	/** Railway public GraphQL API over WebSocket (environmentLogs subscription). */
	readonly RAILWAY_GRAPHQL_WS_URL: string
	/** Max concurrent Railway metrics polls across all targets. */
	readonly RAILWAY_CONNECTOR_CONCURRENCY: number
	/** How often the target list is refreshed, in seconds. */
	readonly RAILWAY_CONNECTOR_RECONCILE_INTERVAL_SECONDS: number
	/** Port for the `/health` endpoint. */
	readonly PORT: number
}

// Defaults target the local dev stack (`bun dev`: api on 3472, ingest on
// 3474, the docker-compose dev token) so the connector boots without extra
// configuration instead of crashing the turbo dev TUI. Production overrides
// the first three (see apps/railway-connector/railway.json deploy notes); a
// missing override degrades to visible per-reconcile warnings, never a crash
// loop.
const envConfig = Config.all({
	MAPLE_API_URL: Config.string("MAPLE_API_URL").pipe(Config.withDefault("http://127.0.0.1:3472")),
	SD_INTERNAL_TOKEN: Config.redacted("SD_INTERNAL_TOKEN").pipe(
		Config.withDefault(Redacted.make("maple-sd-dev-token")),
	),
	MAPLE_INGEST_URL: Config.string("MAPLE_INGEST_URL").pipe(Config.withDefault("http://127.0.0.1:3474")),
	RAILWAY_GRAPHQL_HTTP_URL: Config.string("RAILWAY_GRAPHQL_HTTP_URL").pipe(
		Config.withDefault("https://backboard.railway.com/graphql/v2"),
	),
	RAILWAY_GRAPHQL_WS_URL: Config.string("RAILWAY_GRAPHQL_WS_URL").pipe(
		Config.withDefault("wss://backboard.railway.com/graphql/v2"),
	),
	RAILWAY_CONNECTOR_CONCURRENCY: Config.number("RAILWAY_CONNECTOR_CONCURRENCY").pipe(
		Config.withDefault(10),
	),
	RAILWAY_CONNECTOR_RECONCILE_INTERVAL_SECONDS: Config.number(
		"RAILWAY_CONNECTOR_RECONCILE_INTERVAL_SECONDS",
	).pipe(Config.withDefault(60)),
	PORT: Config.number("PORT").pipe(Config.withDefault(3476)),
})

export class RailwayConnectorEnv extends Context.Service<RailwayConnectorEnv, RailwayConnectorEnvShape>()(
	"@maple/railway-connector/Env",
	{
		make: Effect.map(envConfig, (env) => ({
			...env,
			MAPLE_API_URL: env.MAPLE_API_URL.replace(/\/$/, ""),
			MAPLE_INGEST_URL: env.MAPLE_INGEST_URL.replace(/\/$/, ""),
			RAILWAY_GRAPHQL_HTTP_URL: env.RAILWAY_GRAPHQL_HTTP_URL.replace(/\/$/, ""),
			RAILWAY_GRAPHQL_WS_URL: env.RAILWAY_GRAPHQL_WS_URL.replace(/\/$/, ""),
		})),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
