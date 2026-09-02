import { Context, Duration, Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import {
	InternalScrapeTargetList,
	type InternalScrapeTarget,
	type ScrapeResultReport,
} from "@maple/domain/http"
import { ScraperEnv } from "./Env"

export class ApiRequestError extends Schema.TaggedError<ApiRequestError>()("@maple/scraper/ApiRequestError", {
	message: Schema.String,
	status: Schema.NullOr(Schema.Number),
}) {}

export interface ApiClientApi {
	/**
	 * Enabled scrape targets from `/api/internal/scrape-targets`, each carrying
	 * the URL to fetch and its decrypted auth headers (see {@link InternalScrapeTarget}).
	 */
	readonly listTargets: () => Effect.Effect<ReadonlyArray<InternalScrapeTarget>, ApiRequestError>
	/** Report scrape outcomes to `/api/internal/scrape-results`. */
	readonly reportResults: (
		results: ReadonlyArray<ScrapeResultReport>,
	) => Effect.Effect<void, ApiRequestError>
}

const decodeTargets = Schema.decodeUnknownEffect(InternalScrapeTargetList)

export class ApiClient extends Context.Service<ApiClient, ApiClientApi>()("@maple/scraper/ApiClient", {
	make: Effect.gen(function* () {
		const env = yield* ScraperEnv
		const client = yield* HttpClient.HttpClient

		const authHeaders = {
			authorization: `Bearer ${Redacted.value(env.SD_INTERNAL_TOKEN)}`,
		}

		// Bound every API round-trip. `FetchHttpClient` sets no timeout, so a
		// stalled Worker (e.g. an oversized scrape-results POST) would otherwise
		// hang for minutes; cap it so a flush fails fast and re-buffers instead.
		const REQUEST_TIMEOUT = Duration.seconds(30)

		const transportError = (error: { readonly message: string }) =>
			new ApiRequestError({ message: `Maple API unreachable: ${error.message}`, status: null })

		const listTargets = Effect.fn("ApiClient.listTargets")(function* () {
			const request = HttpClientRequest.get(`${env.MAPLE_API_URL}/api/internal/scrape-targets`, {
				headers: authHeaders,
			})
			const response = yield* client
				.execute(request)
				.pipe(
					Effect.annotateSpans("peer.service", "maple-api"),
					Effect.timeout(REQUEST_TIMEOUT),
					Effect.mapError(transportError),
				)
			const text = yield* response.text.pipe(Effect.mapError(transportError))
			if (response.status < 200 || response.status >= 300) {
				return yield* Effect.fail(
					new ApiRequestError({
						message: `scrape-targets returned HTTP ${response.status}: ${text.slice(0, 200)}`,
						status: response.status,
					}),
				)
			}
			return yield* Effect.try({
				try: () => JSON.parse(text) as unknown,
				catch: () =>
					new ApiRequestError({ message: "scrape-targets returned invalid JSON", status: null }),
			}).pipe(
				Effect.flatMap((json) =>
					decodeTargets(json).pipe(
						Effect.mapError(
							(error) =>
								new ApiRequestError({
									message: `scrape-targets payload mismatch: ${error.message}`,
									status: null,
								}),
						),
					),
				),
			)
		})

		const reportResults = Effect.fn("ApiClient.reportResults")(function* (
			results: ReadonlyArray<ScrapeResultReport>,
		) {
			if (results.length === 0) return
			const request = HttpClientRequest.post(`${env.MAPLE_API_URL}/api/internal/scrape-results`, {
				headers: authHeaders,
			}).pipe(HttpClientRequest.bodyText(JSON.stringify(results), "application/json"))
			const response = yield* client
				.execute(request)
				.pipe(
					Effect.annotateSpans("peer.service", "maple-api"),
					Effect.timeout(REQUEST_TIMEOUT),
					Effect.mapError(transportError),
				)
			if (response.status < 200 || response.status >= 300) {
				return yield* Effect.fail(
					new ApiRequestError({
						message: `scrape-results returned HTTP ${response.status}`,
						status: response.status,
					}),
				)
			}
		})

		return { listTargets, reportResults } satisfies ApiClientApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
