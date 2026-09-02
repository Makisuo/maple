import { Clock, Context, Effect, Layer, Option, Redacted, Ref, Schema, Semaphore } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import type { MobilePushEnvironment } from "@maple/domain/http"
import { Env, type EnvConfig } from "./Env"

/**
 * Apple Push Notification service, token-based (JWT / `.p8`) auth.
 *
 * APNs is HTTP/2-only. Workers' `fetch` negotiates HTTP/2 to origins in
 * production, so this is a plain HTTP client; the known gap is *local*
 * `workerd`, which speaks HTTP/1.1 outbound and gets the connection dropped
 * — hence `ApnsUnavailable` rather than a hard failure when the send blows up
 * in dev. Do not route this through the SSRF-guarded `safeFetch`: the host is
 * ours, fixed, and must be reachable over HTTP/2.
 *
 * Auth is an ES256 JWT (`iss` = team id, `kid` = key id) minted at most once
 * per 50 minutes: Apple rejects tokens older than an hour and throttles
 * clients that mint one per request.
 */

export class ApnsError extends Schema.TaggedError<ApnsError>()("@maple/api/platform/ApnsError", {
	message: Schema.String,
	/** APNs `reason` from the response body, when the send reached Apple. */
	reason: Schema.optionalKey(Schema.String),
	status: Schema.optionalKey(Schema.Number),
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

export interface ApnsAlert {
	readonly title: string
	readonly subtitle?: string | undefined
	readonly body: string
}

export interface ApnsPush {
	readonly deviceToken: string
	readonly environment: MobilePushEnvironment
	readonly bundleId: string
	readonly alert: ApnsAlert
	/** Notifications with the same id replace each other on the device. */
	readonly collapseId?: string | undefined
	/** `time-sensitive` breaks through Focus; use it for critical incidents only. */
	readonly interruptionLevel?: "passive" | "active" | "time-sensitive" | undefined
	/** `10` immediate, `5` power-considerate. */
	readonly priority?: 5 | 10 | undefined
	/** Deep-link and grouping data delivered to the app alongside the alert. */
	readonly data: Record<string, string>
	readonly threadId?: string | undefined
	/**
	 * `undefined` plays the default sound, an explicit `null` plays none.
	 *
	 * The distinction matters: an all-clear that buzzes the phone is the same
	 * interruption as the alert it cancels, and a stream of them is why people
	 * turn the app's notifications off entirely.
	 */
	readonly sound?: string | null | undefined
}

/**
 * A Live Activity push. Same connection and key as an alert push, different
 * topic (`<bundle>.push-type.liveactivity`), different `apns-push-type`, and a
 * payload where everything lives under `aps` rather than beside it.
 *
 * `start` goes to the device's push-to-start token and must carry the
 * attributes; `update` and `end` go to the activity's own token and carry only
 * the content state. Getting the token/event pairing wrong is a 400 from Apple
 * with `BadDeviceToken`, not a no-op.
 */
export interface ApnsLiveActivityPush {
	/** Push-to-start token for `start`; the activity's update token otherwise. */
	readonly pushToken: string
	readonly environment: MobilePushEnvironment
	readonly bundleId: string
	readonly event: "start" | "update" | "end"
	/** Required for `start`; ignored by Apple otherwise. */
	readonly attributesType?: string | undefined
	readonly attributes?: Record<string, unknown> | undefined
	readonly contentState: Record<string, unknown>
	/** Seconds. After this the activity renders as stale rather than as current. */
	readonly staleAfterSeconds?: number | undefined
	/** Seconds from now at which an ended activity leaves the Lock Screen. */
	readonly dismissAfterSeconds?: number | undefined
	/** Optional banner alongside the activity — `start` only, in practice. */
	readonly alert?: ApnsAlert | undefined
	readonly priority?: 5 | 10 | undefined
}

/**
 * A background push: no alert, no sound, no badge — just `content-available`,
 * which wakes the app for a few seconds so it can refresh something.
 *
 * Maple sends exactly one of these, and only for the Home Screen widgets: an
 * incident opening or resolving is the moment the numbers on a Lock Screen are
 * most wrong, and it is the one moment worth spending a wake-up on.
 *
 * Three things about this channel that are easy to get wrong:
 *
 * - **iOS decides.** Background pushes are throttled on a schedule Apple does
 *   not publish and does not honour any particular rate. This is a hint, never
 *   a delivery guarantee, and nothing may depend on one arriving.
 * - **Priority 5, always.** Apple explicitly rejects `content-available` at
 *   priority 10 on newer iOS, and a background push that jumps the queue is
 *   also the one users notice as battery drain.
 * - **It expires.** A wake-up that arrives after the numbers have moved on
 *   again is a wasted radio, so these carry a short expiry and a collapse id —
 *   an organization only ever needs the most recent one.
 */
export interface ApnsBackgroundPush {
	readonly deviceToken: string
	readonly environment: MobilePushEnvironment
	readonly bundleId: string
	/** Delivered to the app alongside the wake-up; `aps` stays alert-free. */
	readonly data: Record<string, string>
	/** Newer wake-ups replace older ones — one per organization is plenty. */
	readonly collapseId?: string | undefined
	/** Seconds. Past this Apple stops trying, which is the wanted behaviour. */
	readonly expiresInSeconds?: number | undefined
}

export type ApnsSendResult =
	| { readonly outcome: "sent"; readonly apnsId: string | null }
	/** Apple says this token is dead: stop sending to it. */
	| { readonly outcome: "unregistered"; readonly reason: string }
	| {
			readonly outcome: "failed"
			readonly status: number
			readonly reason: string
			readonly retryable: boolean
	  }

export interface ApnsClientApi {
	readonly isConfigured: boolean
	readonly send: (push: ApnsPush) => Effect.Effect<ApnsSendResult, ApnsError>
	readonly sendLiveActivity: (push: ApnsLiveActivityPush) => Effect.Effect<ApnsSendResult, ApnsError>
	readonly sendBackground: (push: ApnsBackgroundPush) => Effect.Effect<ApnsSendResult, ApnsError>
}

const APNS_HOSTS = {
	production: "https://api.push.apple.com",
	sandbox: "https://api.sandbox.push.apple.com",
} as const satisfies Record<MobilePushEnvironment, string>

/**
 * Topics this key is allowed to sign for.
 *
 * `bundle_id` arrives from the device registration payload, is stored on the
 * row, and ends up verbatim as `apns-topic` on a request signed with Maple's
 * team key. Unchecked, any authenticated client could make the worker mint
 * provider JWTs for arbitrary topics under Maple's Apple team — and every such
 * row burns a send attempt per incident that Apple answers with
 * `DeviceTokenNotForTopic`. The app ships exactly one bundle id
 * (`PRODUCT_BUNDLE_IDENTIFIER` in `apps/ios/project.yml`), so the set is closed
 * — a build that ships another bundle id adds it here.
 */
const ALLOWED_TOPICS = new Set<string>(["com.maple.mobile"])

/**
 * Live Activity pushes are signed for a *suffixed* topic. Derived rather than
 * listed so the allowlist above stays the single place a bundle id is admitted.
 */
const liveActivityTopic = (bundleId: string) => `${bundleId}.push-type.liveactivity`

/** Reasons that mean the token itself is gone, per Apple's table. */
const UNREGISTERED_REASONS = new Set([
	"Unregistered",
	"BadDeviceToken",
	"DeviceTokenNotForTopic",
	"ExpiredToken",
])

const TOKEN_TTL_MS = 50 * 60 * 1000

const base64UrlString = (value: string) => Buffer.from(value, "utf8").toString("base64url")
const base64UrlBytes = (value: ArrayBuffer) => Buffer.from(value).toString("base64url")

const pemToPkcs8 = (pem: string): ArrayBuffer => {
	const body = pem
		.replace(/-----BEGIN[^-]+-----/g, "")
		.replace(/-----END[^-]+-----/g, "")
		.replace(/\s+/g, "")
	const buf = Buffer.from(body, "base64")
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

interface ApnsConfig {
	readonly teamId: string
	readonly keyId: string
	readonly privateKeyPem: string
}

const resolveConfig = (env: EnvConfig): ApnsConfig | null => {
	const teamId = Option.getOrUndefined(env.APNS_TEAM_ID)
	const keyId = Option.getOrUndefined(env.APNS_KEY_ID)
	const key = Option.getOrUndefined(env.APNS_PRIVATE_KEY)
	if (!teamId || !keyId || !key) return null
	return { teamId, keyId, privateKeyPem: Redacted.value(key) }
}

const decodeReason = Schema.decodeUnknownOption(Schema.Struct({ reason: Schema.String }))

/**
 * TTL cache around `mint` with single-flight refresh. MobilePushService fans
 * out up to eight concurrent sends, so a cold or expired cache would otherwise
 * mint one JWT per fiber — and Apple throttles clients that update provider
 * tokens too often (`TooManyProviderTokenUpdates`). One permit serializes the
 * stale path; waiters re-check the cache and reuse the winner's token.
 * Exported for the concurrency test only.
 */
export const makeSingleFlightTokenCache = <E, R>(
	ttlMs: number,
	mint: Effect.Effect<string, E, R>,
): Effect.Effect<Effect.Effect<string, E, R>> =>
	Ref.make(Option.none<{ readonly value: string; readonly mintedAtMs: number }>()).pipe(
		Effect.map((cached) => {
			const lock = Semaphore.makeUnsafe(1)
			// A cached token counts only while younger than the TTL; expiry is
			// absence, not a null to compare against.
			const freshValue = (nowMs: number) =>
				Ref.get(cached).pipe(
					Effect.map(Option.filter((entry) => nowMs - entry.mintedAtMs < ttlMs)),
					Effect.map(Option.map((entry) => entry.value)),
				)
			return Effect.gen(function* () {
				const nowMs = yield* Clock.currentTimeMillis
				const entry = yield* freshValue(nowMs)
				if (Option.isSome(entry)) return entry.value
				return yield* lock.withPermits(1)(
					Effect.gen(function* () {
						// Double-checked: a fiber that waited here usually finds the
						// winner's fresh token and must not mint another.
						const innerNowMs = yield* Clock.currentTimeMillis
						const latest = yield* freshValue(innerNowMs)
						if (Option.isSome(latest)) return latest.value
						const value = yield* mint
						yield* Ref.set(cached, Option.some({ value, mintedAtMs: innerNowMs }))
						return value
					}),
				)
			})
		}),
	)

export class ApnsClient extends Context.Service<ApnsClient, ApnsClientApi>()(
	"@maple/api/platform/ApnsClient",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const http = yield* HttpClient.HttpClient
			const config = resolveConfig(env)

			if (config === null) {
				const unconfigured = () =>
					Effect.fail(
						new ApnsError({
							message: "APNs is not configured (APNS_TEAM_ID, APNS_KEY_ID, APNS_PRIVATE_KEY)",
						}),
					)
				return {
					isConfigured: false,
					send: unconfigured,
					sendLiveActivity: unconfigured,
					sendBackground: unconfigured,
				} satisfies ApnsClientApi
			}

			// Imported on first use, not at layer build: a malformed key must fail
			// the send (logged, best-effort) rather than the whole alerting graph.
			const signingKey = yield* Effect.cached(
				Effect.tryPromise({
					try: () =>
						crypto.subtle.importKey(
							"pkcs8",
							pemToPkcs8(config.privateKeyPem),
							{ name: "ECDSA", namedCurve: "P-256" },
							false,
							["sign"],
						),
					catch: (cause) => new ApnsError({ message: "Failed to import APNs signing key", cause }),
				}),
			)

			const mintToken = Effect.fn("ApnsClient.mintToken")(function* () {
				const nowMs = yield* Clock.currentTimeMillis
				const header = base64UrlString(JSON.stringify({ alg: "ES256", kid: config.keyId }))
				const payload = base64UrlString(
					JSON.stringify({ iss: config.teamId, iat: Math.floor(nowMs / 1000) }),
				)
				const signingInput = `${header}.${payload}`
				// WebCrypto ECDSA emits the raw r||s form, which is exactly JWS ES256.
				const key = yield* signingKey
				const signature = yield* Effect.tryPromise({
					try: () =>
						crypto.subtle.sign(
							{ name: "ECDSA", hash: "SHA-256" },
							key,
							new TextEncoder().encode(signingInput),
						),
					catch: (cause) => new ApnsError({ message: "APNs JWT signing failed", cause }),
				})
				return `${signingInput}.${base64UrlBytes(signature)}`
			})

			const currentToken = yield* makeSingleFlightTokenCache(TOKEN_TTL_MS, mintToken())

			const send = Effect.fn("ApnsClient.send")(function* (push: ApnsPush) {
				yield* Effect.annotateCurrentSpan({
					"maple.push.environment": push.environment,
					"maple.push.bundle_id": push.bundleId,
					"peer.service": "apns",
				})
				// Before the token is minted: an unknown topic must not reach the
				// signing step at all.
				if (!ALLOWED_TOPICS.has(push.bundleId)) {
					return yield* new ApnsError({
						message: `Refusing to send for an unknown APNs topic: ${push.bundleId}`,
					})
				}
				const token = yield* currentToken
				const body = {
					aps: {
						alert: {
							title: push.alert.title,
							...(push.alert.subtitle !== undefined
								? { subtitle: push.alert.subtitle }
								: undefined),
							body: push.alert.body,
						},
						...(push.sound === null ? undefined : { sound: push.sound ?? "default" }),
						...(push.threadId !== undefined ? { "thread-id": push.threadId } : undefined),
						...(push.interruptionLevel !== undefined
							? { "interruption-level": push.interruptionLevel }
							: undefined),
					},
					...push.data,
				}
				const headers = {
					authorization: `bearer ${token}`,
					"apns-topic": push.bundleId,
					"apns-push-type": "alert",
					"apns-priority": String(push.priority ?? 10),
					// Alerts about the present are worthless an hour later.
					"apns-expiration": String(Math.floor((yield* Clock.currentTimeMillis) / 1000) + 3600),
					...(push.collapseId !== undefined
						? { "apns-collapse-id": push.collapseId.slice(0, 64) }
						: undefined),
				}
				return yield* dispatch(push.environment, push.deviceToken, headers, body)
			})

			const sendBackground = Effect.fn("ApnsClient.sendBackground")(function* (
				push: ApnsBackgroundPush,
			) {
				if (!ALLOWED_TOPICS.has(push.bundleId)) {
					return yield* new ApnsError({
						message: `Refusing to send for an unknown APNs topic: ${push.bundleId}`,
					})
				}
				const token = yield* currentToken
				const body = {
					// `content-available` and nothing else. Any of `alert`, `sound`
					// or `badge` alongside it turns this into a visible
					// notification, which is not what a widget refresh should cost
					// the user.
					aps: { "content-available": 1 },
					...push.data,
				}
				const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000)
				const headers = {
					authorization: `bearer ${token}`,
					"apns-topic": push.bundleId,
					"apns-push-type": "background",
					// Apple rejects `content-available` at priority 10.
					"apns-priority": "5",
					"apns-expiration": String(nowSeconds + (push.expiresInSeconds ?? 900)),
					...(push.collapseId !== undefined
						? { "apns-collapse-id": push.collapseId.slice(0, 64) }
						: undefined),
				}
				return yield* dispatch(push.environment, push.deviceToken, headers, body)
			})

			/**
			 * One POST to Apple and one reading of its answer, shared by both push
			 * kinds: the difference between an alert, a Live Activity and a
			 * background wake-up is entirely in the headers and the body, never in
			 * how a 410 is interpreted.
			 */
			const dispatch = Effect.fn("ApnsClient.dispatch")(function* (
				environment: MobilePushEnvironment,
				pushToken: string,
				headers: Record<string, string>,
				body: unknown,
			) {
				const request = yield* HttpClientRequest.bodyJson(
					HttpClientRequest.post(`${APNS_HOSTS[environment]}/3/device/${pushToken}`, {
						headers,
					}),
					body,
				).pipe(
					Effect.mapError(
						(cause) => new ApnsError({ message: "Failed to encode APNs payload", cause }),
					),
				)

				const response = yield* http
					.execute(request)
					.pipe(
						Effect.mapError((cause) => new ApnsError({ message: "APNs request failed", cause })),
					)
				yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })

				if (response.status === 200) {
					return {
						outcome: "sent",
						apnsId: response.headers["apns-id"] ?? null,
					} satisfies ApnsSendResult
				}

				const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
				const parsed = (() => {
					try {
						return decodeReason(JSON.parse(text))
					} catch {
						return Option.none()
					}
				})()
				const reason = Option.map(parsed, (r) => r.reason).pipe(
					Option.getOrElse(() => `HTTP ${response.status}`),
				)

				if (response.status === 410 || UNREGISTERED_REASONS.has(reason)) {
					return { outcome: "unregistered", reason } satisfies ApnsSendResult
				}
				// 429 and 5xx are worth another try on the next event; 4xx is our bug.
				return {
					outcome: "failed",
					status: response.status,
					reason,
					retryable: response.status === 429 || response.status >= 500,
				} satisfies ApnsSendResult
			})

			const sendLiveActivity = Effect.fn("ApnsClient.sendLiveActivity")(function* (
				push: ApnsLiveActivityPush,
			) {
				yield* Effect.annotateCurrentSpan({
					"maple.push.environment": push.environment,
					"maple.push.bundle_id": push.bundleId,
					"maple.push.live_activity_event": push.event,
					"peer.service": "apns",
				})
				if (!ALLOWED_TOPICS.has(push.bundleId)) {
					return yield* new ApnsError({
						message: `Refusing to send for an unknown APNs topic: ${push.bundleId}`,
					})
				}
				const token = yield* currentToken
				const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000)
				const body = {
					aps: {
						// Seconds, and Apple drops an update whose timestamp is not
						// newer than the last one it delivered — so it is the wall
						// clock, never a constant.
						timestamp: nowSeconds,
						event: push.event,
						"content-state": push.contentState,
						...(push.event === "start" && push.attributesType !== undefined
							? { "attributes-type": push.attributesType, attributes: push.attributes ?? {} }
							: undefined),
						...(push.staleAfterSeconds !== undefined
							? { "stale-date": nowSeconds + push.staleAfterSeconds }
							: undefined),
						...(push.event === "end" && push.dismissAfterSeconds !== undefined
							? { "dismissal-date": nowSeconds + push.dismissAfterSeconds }
							: undefined),
						...(push.alert !== undefined
							? {
									alert: {
										title: push.alert.title,
										...(push.alert.subtitle !== undefined
											? { subtitle: push.alert.subtitle }
											: undefined),
										body: push.alert.body,
									},
								}
							: undefined),
					},
				}
				const headers = {
					authorization: `bearer ${token}`,
					"apns-topic": liveActivityTopic(push.bundleId),
					"apns-push-type": "liveactivity",
					"apns-priority": String(push.priority ?? 10),
					"apns-expiration": String(nowSeconds + 3600),
				}
				return yield* dispatch(push.environment, push.pushToken, headers, body)
			})

			return { isConfigured: true, send, sendLiveActivity, sendBackground } satisfies ApnsClientApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
