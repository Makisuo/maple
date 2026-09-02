import { Config, Context, Effect, Layer, Redacted, Schema } from "effect"

export interface ScraperEnvConfig {
	/** Base URL of the Maple API, e.g. `https://api.maple.dev`. */
	readonly MAPLE_API_URL: string
	/** Shared internal bearer for the `/api/internal/*` scraper endpoints. */
	readonly SD_INTERNAL_TOKEN: Redacted.Redacted<string>
	/**
	 * Base URL of the Maple ingest gateway, e.g. `https://ingest.maple.dev`.
	 * Scraped metrics are sent here as OTLP/JSON with each org's public
	 * ingest key so they get billed and warehouse-routed per org.
	 */
	readonly MAPLE_INGEST_URL: string
	/** Max concurrent scrapes across all targets. */
	readonly SCRAPER_CONCURRENCY: number
	/** How often the target list is refreshed, in seconds. */
	readonly SCRAPER_RECONCILE_INTERVAL_SECONDS: number
	/**
	 * Max OTLP data points per POST to the ingest gateway. A scrape larger than
	 * this is split across several requests so none can trip the gateway's
	 * `INGEST_MAX_REQUEST_BODY_BYTES` (20 MB), which rejects an oversized body
	 * whole and loses the entire scrape.
	 */
	readonly SCRAPER_OTLP_MAX_DATA_POINTS: number
	/** Port for the `/health` endpoint. */
	readonly PORT: number
}

// Defaults target the local dev stack (`bun dev`: api on 3472, ingest on
// 3474, the docker-compose dev token) so the scraper boots without extra
// configuration instead of crashing the turbo dev TUI. Production overrides
// all three (see apps/scraper/railway.json deploy notes); a missing override
// degrades to visible per-reconcile warnings, never a crash loop.
//
// Numeric settings ARE validated at layer build, unlike the URLs: a missing
// URL fails loudly every reconcile, but SCRAPER_CONCURRENCY=0 builds a
// semaphore that never grants a permit — every target silently suspended
// while /health keeps answering 200 — and a fractional or non-positive
// interval/chunk size misbehaves just as quietly. Failing startup is the
// only visible place for those.
const positiveInt = (name: string, maximum: number) =>
	Config.schema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum })), name)

const envConfig = Config.all({
	MAPLE_API_URL: Config.string("MAPLE_API_URL").pipe(Config.withDefault("http://127.0.0.1:3472")),
	SD_INTERNAL_TOKEN: Config.redacted("SD_INTERNAL_TOKEN").pipe(
		Config.withDefault(Redacted.make("maple-sd-dev-token")),
	),
	MAPLE_INGEST_URL: Config.string("MAPLE_INGEST_URL").pipe(Config.withDefault("http://127.0.0.1:3474")),
	SCRAPER_CONCURRENCY: positiveInt("SCRAPER_CONCURRENCY", 10_000).pipe(Config.withDefault(10)),
	SCRAPER_RECONCILE_INTERVAL_SECONDS: positiveInt("SCRAPER_RECONCILE_INTERVAL_SECONDS", 24 * 60 * 60).pipe(
		Config.withDefault(60),
	),
	// 10k points is ~2 MB of OTLP/JSON at the attribute density Prometheus
	// exporters produce — a 10x margin under the gateway's 20 MB limit, so
	// even an unusually attribute-heavy exporter stays inside it.
	SCRAPER_OTLP_MAX_DATA_POINTS: positiveInt("SCRAPER_OTLP_MAX_DATA_POINTS", 10_000_000).pipe(
		Config.withDefault(10_000),
	),
	PORT: positiveInt("PORT", 65_535).pipe(Config.withDefault(3475)),
})

export class ScraperEnv extends Context.Service<ScraperEnv, ScraperEnvConfig>()("@maple/scraper/Env", {
	make: Effect.map(envConfig, (env) => ({
		...env,
		MAPLE_API_URL: env.MAPLE_API_URL.replace(/\/$/, ""),
		MAPLE_INGEST_URL: env.MAPLE_INGEST_URL.replace(/\/$/, ""),
	})),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
