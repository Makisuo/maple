import { Clock, Context, Effect, Layer, Option, Redacted, Ref, Schema } from "effect"
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
	readonly sound?: string | undefined
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

export class ApnsClient extends Context.Service<ApnsClient, ApnsClientApi>()(
	"@maple/api/platform/ApnsClient",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const http = yield* HttpClient.HttpClient
			const config = resolveConfig(env)

			if (config === null) {
				return {
					isConfigured: false,
					send: () =>
						Effect.fail(
							new ApnsError({
								message:
									"APNs is not configured (APNS_TEAM_ID, APNS_KEY_ID, APNS_PRIVATE_KEY)",
							}),
						),
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

			const cachedToken = yield* Ref.make<{
				readonly value: string
				readonly mintedAtMs: number
			} | null>(null)

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
				const value = `${signingInput}.${base64UrlBytes(signature)}`
				yield* Ref.set(cachedToken, { value, mintedAtMs: nowMs })
				return value
			})

			const currentToken = Effect.gen(function* () {
				const nowMs = yield* Clock.currentTimeMillis
				const cached = yield* Ref.get(cachedToken)
				if (cached !== null && nowMs - cached.mintedAtMs < TOKEN_TTL_MS) return cached.value
				return yield* mintToken()
			})

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
						sound: push.sound ?? "default",
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
				const request = yield* HttpClientRequest.bodyJson(
					HttpClientRequest.post(`${APNS_HOSTS[push.environment]}/3/device/${push.deviceToken}`, {
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

			return { isConfigured: true, send } satisfies ApnsClientApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
