import { Context, Duration, Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import {
	InternalRailwayTargetList,
	type InternalRailwayTarget,
	type RailwayResultReport,
} from "@maple/domain/http"
import { RailwayConnectorEnv } from "./Env"

export class ApiRequestError extends Schema.TaggedErrorClass<ApiRequestError>()(
	"@maple/railway-connector/ApiRequestError",
	{
		message: Schema.String,
		status: Schema.NullOr(Schema.Number),
	},
) {}

export interface ApiClientShape {
	/** Enabled Railway targets from `/api/internal/railway-targets`. */
	readonly listTargets: () => Effect.Effect<ReadonlyArray<InternalRailwayTarget>, ApiRequestError>
	/** Report log/metrics outcomes to `/api/internal/railway-results`. */
	readonly reportResults: (
		results: ReadonlyArray<RailwayResultReport>,
	) => Effect.Effect<void, ApiRequestError>
}

const decodeTargets = Schema.decodeUnknownEffect(InternalRailwayTargetList)

export class ApiClient extends Context.Service<ApiClient, ApiClientShape>()(
	"@maple/railway-connector/ApiClient",
	{
		make: Effect.gen(function* () {
			const env = yield* RailwayConnectorEnv
			const client = yield* HttpClient.HttpClient

			const authHeaders = {
				authorization: `Bearer ${Redacted.value(env.SD_INTERNAL_TOKEN)}`,
			}

			// Bound every API round-trip so a stalled Worker fails fast and the
			// caller re-buffers instead of hanging.
			const REQUEST_TIMEOUT = Duration.seconds(30)

			const transportError = (error: { readonly message: string }) =>
				new ApiRequestError({ message: `Maple API unreachable: ${error.message}`, status: null })

			const listTargets = Effect.fn("ApiClient.listTargets")(function* () {
				const request = HttpClientRequest.get(`${env.MAPLE_API_URL}/api/internal/railway-targets`, {
					headers: authHeaders,
				})
				const response = yield* client
					.execute(request)
					.pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.mapError(transportError))
				const text = yield* response.text.pipe(Effect.mapError(transportError))
				if (response.status < 200 || response.status >= 300) {
					return yield* Effect.fail(
						new ApiRequestError({
							message: `railway-targets returned HTTP ${response.status}: ${text.slice(0, 200)}`,
							status: response.status,
						}),
					)
				}
				return yield* Effect.try({
					try: () => JSON.parse(text) as unknown,
					catch: () =>
						new ApiRequestError({ message: "railway-targets returned invalid JSON", status: null }),
				}).pipe(
					Effect.flatMap((json) =>
						decodeTargets(json).pipe(
							Effect.mapError(
								(error) =>
									new ApiRequestError({
										message: `railway-targets payload mismatch: ${error.message}`,
										status: null,
									}),
							),
						),
					),
				)
			})

			const reportResults = Effect.fn("ApiClient.reportResults")(function* (
				results: ReadonlyArray<RailwayResultReport>,
			) {
				if (results.length === 0) return
				const request = HttpClientRequest.post(`${env.MAPLE_API_URL}/api/internal/railway-results`, {
					headers: authHeaders,
				}).pipe(HttpClientRequest.bodyText(JSON.stringify(results), "application/json"))
				const response = yield* client
					.execute(request)
					.pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.mapError(transportError))
				if (response.status < 200 || response.status >= 300) {
					return yield* Effect.fail(
						new ApiRequestError({
							message: `railway-results returned HTTP ${response.status}`,
							status: response.status,
						}),
					)
				}
			})

			return { listTargets, reportResults } satisfies ApiClientShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
