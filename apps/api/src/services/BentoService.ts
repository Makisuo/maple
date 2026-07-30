import { Context, Duration, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Env } from "../lib/Env"

/**
 * Bento (bentonow.com) client — owns the onboarding drip sequence.
 *
 * Two operations with deliberately different blast radii:
 *
 * - `upsertSubscriber` → `POST /batch/subscribers`, which Bento documents as
 *   *not* triggering Flows or Automations. Safe to run over the whole org table.
 * - `trackEvent` → `POST /batch/events`, which is what Flows trigger on. This is
 *   the only call in the codebase that can cause a customer to receive email.
 *
 * Keeping them separate is the core safety property of the migration: a
 * subscriber backfill necessarily touches every org, so if Flows triggered on
 * "subscriber created" a backfill would mass-mail the user base. Flows must
 * trigger on the event, never on subscriber creation.
 *
 * Containment is layered, in decreasing order of trustworthiness:
 *   1. Credential scoping — prd-only secrets in alchemy point at the `maple-prod`
 *      site; non-prod stages get the `maple-nonprod` site (zero automations) or
 *      nothing. This is the layer that survives a bad `MAPLE_ENVIRONMENT`.
 *   2. The `enabled` gate below, re-checked inside every mutating method so a
 *      caller holding a handle cannot skip it.
 *   3. Flow entry conditions in Bento's UI (`maple_cohort == live`).
 *
 * @see docs/onboarding-sequence.md for the flow definitions this drives.
 */

const REQUEST_TIMEOUT = Duration.seconds(15)

/** Cloudflare blocks Bento API requests that arrive without a User-Agent. */
const USER_AGENT = "maple-api"

export class BentoError extends Schema.TaggedErrorClass<BentoError>()("@maple/errors/BentoError", {
	message: Schema.String,
	status: Schema.optionalKey(Schema.Number),
}) {}

/**
 * Raised when a call is made while Bento is disabled (missing credentials, or a
 * non-production stage without the escape hatch). A distinct tag from
 * `BentoError` so callers can count suppressions separately from real failures —
 * a tick reporting `bentoFailures: 0, eventsSuppressed: 400` is healthy on
 * staging and alarming in production.
 */
export class BentoSuppressedError extends Schema.TaggedErrorClass<BentoSuppressedError>()(
	"@maple/errors/BentoSuppressedError",
	{ message: Schema.String },
) {}

/** Subscriber profile fields. Bento rejects nested values here. */
export interface BentoSubscriberFields {
	readonly [key: string]: string | number | boolean
}

export interface BentoUpsertSubscriberInput {
	readonly email: string
	readonly fields: BentoSubscriberFields
	/** ISO 8601 join date — the org's creation time, not the sync time. */
	readonly createdAt?: string | undefined
}

export interface BentoTrackEventInput {
	readonly email: string
	/** Event name, e.g. `maple.onboarding.started`. */
	readonly type: string
	/** Merged into the subscriber profile alongside recording the event. */
	readonly fields?: BentoSubscriberFields | undefined
	/**
	 * Event metadata. Always carries `dedupe_key` so a duplicate is visible in
	 * Bento's event log during a postmortem, even though Bento does not dedupe
	 * on it — our own claim table is the actual idempotency guard.
	 */
	readonly details?: Record<string, unknown> | undefined
}

export interface BentoBatchResult {
	readonly results: number
	readonly failed: number
}

export interface BentoServiceShape {
	/**
	 * True when credentials are present AND the stage is allowed to reach Bento.
	 * Callers should branch on this to skip work entirely; every method re-checks
	 * it regardless.
	 */
	readonly isConfigured: boolean
	/** Bulk create/update. Does NOT trigger Bento Flows. */
	readonly upsertSubscribers: (
		subscribers: ReadonlyArray<BentoUpsertSubscriberInput>,
	) => Effect.Effect<BentoBatchResult, BentoError | BentoSuppressedError>
	/** Records an event. This DOES trigger Bento Flows — the only path that can email. */
	readonly trackEvent: (
		input: BentoTrackEventInput,
	) => Effect.Effect<BentoBatchResult, BentoError | BentoSuppressedError>
}

/**
 * Lenient decoder — Bento returns `{ results, failed }`; anything else is
 * ignored. Both are treated as optional because a 200 with an unexpected body
 * should surface as "0 accepted", not as a decode crash mid-tick.
 */
const BatchResponseSchema = Schema.Struct({
	results: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	failed: Schema.optionalKey(Schema.NullOr(Schema.Number)),
})

const decodeBatchResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(BatchResponseSchema))

export class BentoService extends Context.Service<BentoService, BentoServiceShape>()(
	"@maple/api/services/BentoService",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const httpClient = yield* HttpClient.HttpClient
			const apiBase = env.BENTO_API_BASE_URL.replace(/\/$/, "")

			const credentials = Option.all({
				siteUuid: env.BENTO_SITE_UUID,
				publishableKey: env.BENTO_PUBLISHABLE_KEY,
				secretKey: env.BENTO_SECRET_KEY,
			})

			// Mirrors EmailService.emailAllowed. MAPLE_BENTO_ALLOW_NONPROD is
			// intentionally NOT MAPLE_ALERTING_ALLOW_NONPROD: exercising the crons on
			// a staging stage is routine and must not imply permission to write real
			// contacts into the production Bento site.
			const stageAllowed =
				env.MAPLE_ENVIRONMENT === "production" || env.MAPLE_BENTO_ALLOW_NONPROD === "true"
			const isConfigured = Option.isSome(credentials) && stageAllowed
			const dryRun = env.MAPLE_BENTO_DRY_RUN === "true"

			const suppressed = (operation: string) =>
				new BentoSuppressedError({
					message: Option.isNone(credentials)
						? `Bento ${operation} suppressed: credentials are not configured`
						: `Bento ${operation} suppressed: disabled in ${env.MAPLE_ENVIRONMENT} (set MAPLE_BENTO_ALLOW_NONPROD=true to override)`,
				})

			const post = Effect.fn("BentoService.post")(function* (
				path: string,
				body: unknown,
				operation: string,
			) {
				// Re-checked here rather than only at the call site so a caller holding
				// a service handle cannot bypass the gate.
				const creds = yield* Option.match(credentials, {
					onNone: () => Effect.fail(suppressed(operation)),
					onSome: (value) => (stageAllowed ? Effect.succeed(value) : Effect.fail(suppressed(operation))),
				})

				if (dryRun) {
					// PII: the payload contains recipient addresses, so log shape only.
					yield* Effect.logInfo("Bento dry run — request not sent").pipe(
						Effect.annotateLogs({ operation, path }),
					)
					return { results: 0, failed: 0 }
				}

				const authorization = `Basic ${Buffer.from(
					`${Redacted.value(creds.publishableKey)}:${Redacted.value(creds.secretKey)}`,
				).toString("base64")}`

				const response = yield* Effect.gen(function* () {
					const request = HttpClientRequest.post(
						`${apiBase}${path}?site_uuid=${encodeURIComponent(creds.siteUuid)}`,
						{
							headers: {
								Authorization: authorization,
								Accept: "application/json",
								"User-Agent": USER_AGENT,
							},
						},
					).pipe(HttpClientRequest.bodyJsonUnsafe(body))
					const res = yield* httpClient.execute(request)
					const text = yield* res.text
					return { status: res.status, text }
				}).pipe(
					Effect.mapError(
						(error) => new BentoError({ message: `Bento ${operation} request failed: ${error.message}` }),
					),
					Effect.timeoutOrElse({
						duration: REQUEST_TIMEOUT,
						orElse: () => Effect.fail(new BentoError({ message: `Bento ${operation} timed out` })),
					}),
				)

				if (response.status < 200 || response.status >= 300) {
					return yield* Effect.fail(
						new BentoError({
							message: `Bento ${operation} returned HTTP ${response.status}`,
							status: response.status,
						}),
					)
				}

				const decoded = yield* decodeBatchResponse(response.text).pipe(
					Effect.mapError(
						() => new BentoError({ message: `Bento ${operation} returned an unexpected payload` }),
					),
				)
				const result = { results: decoded.results ?? 0, failed: decoded.failed ?? 0 }

				// PII: never stamp subscriber addresses on spans or logs.
				yield* Effect.annotateCurrentSpan("bento.operation", operation)
				yield* Effect.annotateCurrentSpan("bento.results", result.results)
				yield* Effect.annotateCurrentSpan("bento.failed", result.failed)
				return result
			})

			const upsertSubscribers = Effect.fn("BentoService.upsertSubscribers")(function* (
				subscribers: ReadonlyArray<BentoUpsertSubscriberInput>,
			) {
				if (subscribers.length === 0) return { results: 0, failed: 0 }
				return yield* post(
					"/batch/subscribers",
					{
						subscribers: subscribers.map((subscriber) => ({
							email: subscriber.email,
							...(subscriber.createdAt ? { created_at: subscriber.createdAt } : {}),
							...subscriber.fields,
						})),
					},
					"upsertSubscribers",
				)
			})

			const trackEvent = Effect.fn("BentoService.trackEvent")(function* (input: BentoTrackEventInput) {
				return yield* post(
					"/batch/events",
					{
						events: [
							{
								type: input.type,
								email: input.email,
								...(input.fields ? { fields: input.fields } : {}),
								...(input.details ? { details: input.details } : {}),
							},
						],
					},
					"trackEvent",
				)
			})

			return { isConfigured, upsertSubscribers, trackEvent }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
