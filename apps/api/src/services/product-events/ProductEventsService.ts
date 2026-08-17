import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Env } from "@/platform/Env"

/**
 * Server-side product events for Maple's own funnel (`signup_completed`,
 * `plan_started`, …). Each call POSTs one NDJSON line to the ingest gateway's
 * `POST /v1/events`, authenticated with the same ingest key the API uses for its
 * own telemetry, so the rows land in the dogfood org next to the browser
 * `track()` events from `maple-web` / `maple-landing`.
 *
 * `track` never fails the caller: the request is bounded (timeout + one retry)
 * and any failure is logged at debug and swallowed. It runs INLINE rather than
 * on a forked fiber — on Workers a fiber forked into the request scope is
 * interrupted the moment the response is returned, and the worker never hands
 * `ExecutionContext.waitUntil` into the Effect graph (see
 * `OrgClickHouseSettingsService.refreshCachedSettings`), so "fire-and-forget"
 * would silently drop most events. Callers that cannot afford ~1 RTT wrap it in
 * `forkRequestScoped` themselves.
 *
 * Wire contract (mirrors `/v1/sessionEvents` sanitising): `name` ≤ 128 chars,
 * not `$`-prefixed; ≤ 32 attributes, key ≤ 64, value ≤ 1024. Excess is trimmed
 * here so a malformed emit degrades to a shorter row rather than a 400.
 */

export class ProductEventsError extends Schema.TaggedError<ProductEventsError>()(
	"@maple/api/services/product-events/ProductEventsError",
	{
		message: Schema.String,
		status: Schema.optionalKey(Schema.Number),
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

export type ProductEventName =
	| "signup_completed"
	| "plan_checkout_started"
	| "plan_started"
	| "plan_changed"
	| "plan_cancelled"

export interface ProductEventInput {
	readonly name: ProductEventName
	readonly userId?: string | undefined
	readonly groupId?: string | undefined
	readonly attributes?: Readonly<Record<string, string>> | undefined
	/** Epoch ms; defaults to now. Webhooks pass the provider's own timestamp. */
	readonly timestamp?: number | undefined
}

/** One NDJSON line as the ingest gateway expects it. Exported for tests. */
export interface ProductEventLine {
	readonly name: string
	readonly timestamp: string
	readonly source: "server"
	readonly service_name: "maple-api"
	readonly user_id?: string
	readonly group_id?: string
	readonly attributes?: Record<string, string>
}

export interface ProductEventsApi {
	/** Emit an event. Never fails; a dropped event is logged at debug. */
	readonly track: (event: ProductEventInput) => Effect.Effect<void>
	/** Whether an ingest key is configured — `track` is a no-op otherwise. */
	readonly enabled: boolean
}

export const PRODUCT_EVENTS_PATH = "/v1/events"
const MAX_NAME_LENGTH = 128
const MAX_ATTRIBUTES = 32
const MAX_ATTRIBUTE_KEY = 64
const MAX_ATTRIBUTE_VALUE = 1024
const REQUEST_TIMEOUT = "2500 millis"
const RETRIES = 1

const trimTrailingSlash = (url: string) => url.replace(/\/+$/, "")

const sanitizeAttributes = (
	attributes: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined => {
	if (attributes === undefined) return undefined
	const out: Record<string, string> = {}
	let count = 0
	for (const [key, value] of Object.entries(attributes)) {
		if (count >= MAX_ATTRIBUTES) break
		if (key.length === 0 || key.length > MAX_ATTRIBUTE_KEY) continue
		if (typeof value !== "string" || value.length === 0) continue
		out[key] = value.length > MAX_ATTRIBUTE_VALUE ? value.slice(0, MAX_ATTRIBUTE_VALUE) : value
		count += 1
	}
	return count === 0 ? undefined : out
}

/** Pure projection input → wire line. Exported so the shape is testable without HTTP. */
export const toProductEventLine = (event: ProductEventInput, nowMs: number): ProductEventLine => {
	const attributes = sanitizeAttributes(event.attributes)
	return {
		name: event.name.slice(0, MAX_NAME_LENGTH),
		timestamp: new Date(event.timestamp ?? nowMs).toISOString(),
		source: "server",
		service_name: "maple-api",
		...(event.userId !== undefined && event.userId.length > 0 ? { user_id: event.userId } : undefined),
		...(event.groupId !== undefined && event.groupId.length > 0
			? { group_id: event.groupId }
			: undefined),
		...(attributes !== undefined ? { attributes } : undefined),
	}
}

const toError = (message: string) => (cause: unknown) =>
	new ProductEventsError({
		message: cause instanceof Error ? `${message}: ${cause.message}` : message,
		cause,
	})

const isRetryable = (error: ProductEventsError) =>
	// Network failures, timeouts and 5xx/429 retry once; a 4xx is our bug and
	// retrying it is noise.
	error.status === undefined || error.status >= 500 || error.status === 429

export const makeProductEvents = (options: {
	readonly httpClient: HttpClient.HttpClient
	readonly endpoint: string
	readonly ingestKey: string | undefined
}): ProductEventsApi => {
	const url = `${trimTrailingSlash(options.endpoint)}${PRODUCT_EVENTS_PATH}`
	const ingestKey = options.ingestKey

	const post = (line: ProductEventLine): Effect.Effect<void, ProductEventsError> =>
		Effect.gen(function* () {
			const request = HttpClientRequest.post(url, {
				headers: { Authorization: `Bearer ${ingestKey}` },
			}).pipe(HttpClientRequest.bodyText(`${JSON.stringify(line)}\n`, "application/x-ndjson"))
			const response = yield* options.httpClient
				.execute(request)
				.pipe(Effect.mapError(toError("Product event request failed")))
			yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
			if (response.status < 200 || response.status >= 300) {
				return yield* new ProductEventsError({
					message: `Ingest gateway answered ${response.status} for ${line.name}`,
					status: response.status,
				})
			}
		}).pipe(
			Effect.timeoutOrElse({
				duration: REQUEST_TIMEOUT,
				orElse: () =>
					new ProductEventsError({ message: `Product event request timed out (${line.name})` }),
			}),
		)

	const track = Effect.fn("ProductEvents.track")(function* (event: ProductEventInput) {
		yield* Effect.annotateCurrentSpan({
			"maple.product_event.name": event.name,
			"maple.product_event.enabled": ingestKey !== undefined,
		})
		if (ingestKey === undefined) {
			yield* Effect.logDebug("Product event dropped: no ingest key configured").pipe(
				Effect.annotateLogs({ event: event.name }),
			)
			return
		}
		const now = yield* Clock.currentTimeMillis
		const line = toProductEventLine(event, now)
		yield* post(line).pipe(
			Effect.retry({ times: RETRIES, while: isRetryable }),
			Effect.catchCause((cause) =>
				Effect.logDebug("Product event dropped").pipe(
					Effect.annotateLogs({ event: event.name, cause: String(cause) }),
					Effect.tap(() => Effect.annotateCurrentSpan({ "maple.product_event.dropped": true })),
				),
			),
		)
	})

	return { track, enabled: ingestKey !== undefined }
}

export class ProductEventsService extends Context.Service<ProductEventsService, ProductEventsApi>()(
	"@maple/api/services/product-events/ProductEventsService",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const httpClient = yield* HttpClient.HttpClient
			const ingestKey = Option.getOrUndefined(
				Option.orElse(env.MAPLE_PRODUCT_EVENTS_INGEST_KEY, () => env.MAPLE_INGEST_KEY),
			)
			const endpoint = Option.getOrElse(env.MAPLE_ENDPOINT, () => env.MAPLE_INGEST_PUBLIC_URL)
			return makeProductEvents({
				httpClient,
				endpoint,
				ingestKey: ingestKey === undefined ? undefined : Redacted.value(ingestKey),
			})
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
	/** Drop everything — for tests and non-HTTP entrypoints that never emit. */
	static readonly noop = Layer.succeed(this, { track: () => Effect.void, enabled: false })
}
