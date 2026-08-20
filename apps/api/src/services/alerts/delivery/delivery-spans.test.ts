import type { AlertDestinationRow } from "@maple/db"
import { AlertDeliveryError, AlertDestinationId } from "@maple/domain/http"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { makeRecordingTracer, spansNamed } from "@/testing/recording-tracer"
import { dispatchDelivery, type DispatchDeps } from "./dispatch"
import type { DispatchContext } from "./context"

/**
 * The outbound provider call must be a **Client-kind span carrying
 * `peer.service`** — that pair is what draws Slack/PagerDuty/Discord/Hazel as
 * nodes on the service map and makes their latency and status attributable.
 * Before the transport registry existed, `dispatchDelivery` had no span at all
 * and no provider arm had one, so every provider dependency was invisible.
 * These assertions are the regression guard for that (same reasoning as
 * `GithubAppClient.span.test.ts`).
 *
 * They also guard the secret-leak rule: Discord and Hazel webhook URLs embed
 * their delivery token in the PATH, so those transports must annotate
 * `server.address` only — never `url.path`, and never `url.full`.
 */

const DESTINATION_ID = Schema.decodeUnknownSync(AlertDestinationId)("7c6b5a49-3821-4e0f-9d8c-7b6a59483726")

const HTTP_SPAN = "AlertDelivery.http"

const destinationRow: AlertDestinationRow = {
	id: DESTINATION_ID,
	orgId: "org_1" as AlertDestinationRow["orgId"],
	name: "Destination",
	type: "webhook",
	enabled: true,
	configJson: {},
	secretCiphertext: "",
	secretIv: "",
	secretTag: "",
	lastTestedAt: null,
	lastTestError: null,
	createdAt: new Date(0),
	updatedAt: new Date(0),
	createdBy: "user_1",
	updatedBy: "user_1",
}

const contextFor = (secretConfig: DispatchContext["secretConfig"]): DispatchContext => ({
	deliveryKey: "org_1:dest_1:delivery",
	destination: { ...destinationRow, type: secretConfig.type },
	publicConfig: { summary: "Checkout error rate", channelLabel: null },
	secretConfig,
	ruleId: "rule_1",
	ruleName: "Checkout error rate",
	groupKey: null,
	signalType: "error_rate",
	severity: "critical",
	comparator: "gt",
	threshold: 0.05,
	thresholdUpper: null,
	eventType: "trigger",
	incidentId: "inc_1",
	incidentStatus: "open",
	dedupeKey: "org_1:rule_1:checkout",
	windowMinutes: 5,
	value: 0.08,
	sampleCount: 1200,
	template: null,
	sentAtMs: Date.parse("2026-06-02T00:00:00.000Z"),
})

const deps = (token = "xoxb-token"): DispatchDeps => ({
	sendEmail: () =>
		Effect.fail(new AlertDeliveryError({ message: "unexpected sendEmail", destinationType: "email" })),
	resolveSlackBotToken: () => Effect.succeed(token),
})

const respondWith =
	(make: () => Response): typeof fetch =>
	async () =>
		make()

const dispatch = (context: DispatchContext, fetchFn: typeof fetch) =>
	dispatchDelivery(
		context,
		"{}",
		fetchFn,
		5_000,
		"https://web.localhost/alerts",
		"https://web.localhost/chat",
		deps(),
	)

describe("AlertDelivery.http span", () => {
	const cases = [
		{
			name: "slack-bot",
			config: { type: "slack-bot", channelId: "C1", channelName: "incidents" } as const,
			peerService: "slack",
			host: "slack.com",
			expectPath: "/api/chat.postMessage",
			respond: () => new Response(JSON.stringify({ ok: true, ts: "1.2" }), { status: 200 }),
		},
		{
			name: "pagerduty",
			config: { type: "pagerduty", integrationKey: "k" } as const,
			peerService: "pagerduty",
			host: "events.pagerduty.com",
			expectPath: "/v2/enqueue",
			respond: () => new Response("", { status: 202 }),
		},
		{
			name: "webhook",
			config: {
				type: "webhook",
				url: "https://hooks.example.test/maple",
				signingSecret: null,
			} as const,
			peerService: "webhook",
			host: "hooks.example.test",
			expectPath: "/maple",
			respond: () => new Response("", { status: 200 }),
		},
		{
			name: "discord",
			config: {
				type: "discord",
				webhookUrl: "https://discord.com/api/webhooks/1/s3cr3t-token",
			} as const,
			peerService: "discord",
			host: "discord.com",
			// The webhook token is a path segment — the path must NOT be recorded.
			expectPath: null,
			// Discord answers a plain webhook POST with 204 and no body.
			respond: () => new Response(null, { status: 204 }),
		},
		{
			name: "hazel-oauth",
			config: {
				type: "hazel-oauth",
				hazelOrganizationId: "o",
				hazelOrganizationName: "Acme",
				hazelChannelId: "c",
				hazelChannelName: "incidents",
				webhookId: "wh_1",
				webhookUrl: "https://hazel.test/api/webhooks/wh_1/s3cr3t-token",
				webhookToken: "s3cr3t-token",
			} as const,
			peerService: "hazel",
			host: "hazel.test",
			expectPath: null,
			respond: () => new Response("", { status: 200 }),
		},
		{
			name: "telegram",
			config: { type: "telegram", botToken: "123456789:s3cr3t-token", chatId: "-100123" } as const,
			peerService: "telegram",
			host: "api.telegram.org",
			// A fixed vendor host, but the bot token is a path segment — the first
			// provider where the guard flag and the path flag disagree.
			expectPath: null,
			respond: () =>
				new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 }),
		},
	]

	for (const testCase of cases) {
		it.effect(`${testCase.name}: is a client span with peer.service and no leaked secret`, () =>
			Effect.gen(function* () {
				const { spans, tracer } = makeRecordingTracer()

				yield* dispatch(contextFor(testCase.config), respondWith(testCase.respond)).pipe(
					Effect.withTracer(tracer),
				)

				const [span, ...rest] = spansNamed(spans, HTTP_SPAN)
				assert.isDefined(span, `${testCase.name} must emit an ${HTTP_SPAN} span`)
				// Guards against reintroducing an `Effect.withSpan` alongside the
				// `Effect.fn` — that emits two spans that disagree on timeout.
				assert.deepStrictEqual(rest, [], "exactly one provider span per delivery")

				assert.strictEqual(span!.kind, "client")
				assert.strictEqual(span!.attributes.get("peer.service"), testCase.peerService)
				assert.strictEqual(span!.attributes.get("server.address"), testCase.host)
				assert.strictEqual(span!.attributes.get("http.request.method"), "POST")
				assert.isUndefined(span!.attributes.get("url.full"))

				if (testCase.expectPath === null) {
					assert.isUndefined(
						span!.attributes.get("url.path"),
						"the webhook token is a path segment — the path must stay off the span",
					)
				} else {
					assert.strictEqual(span!.attributes.get("url.path"), testCase.expectPath)
				}

				for (const value of span!.attributes.values()) {
					assert.notInclude(String(value), "s3cr3t")
					assert.notInclude(String(value), "xoxb-token")
				}
			}),
		)
	}

	it.effect("records the upstream status even when the delivery fails", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			const context = contextFor({
				type: "webhook",
				url: "https://hooks.example.test/maple",
				signingSecret: null,
			})

			const exit = yield* dispatch(
				context,
				respondWith(() => new Response("nope", { status: 503 })),
			).pipe(Effect.withTracer(tracer), Effect.exit)
			assert.strictEqual(exit._tag, "Failure")

			// The status lands on the span even though the call failed, so an
			// upstream 5xx is attributable without parsing the error message.
			const [span] = spansNamed(spans, HTTP_SPAN)
			assert.isDefined(span)
			assert.strictEqual(span!.attributes.get("http.response.status_code"), 503)
			assert.strictEqual(span!.attributes.get("peer.service"), "webhook")
		}),
	)

	it.effect("emits no provider span for the non-HTTP email transport", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			const context = contextFor({
				type: "email",
				members: [{ userId: "u1", email: "on-call@example.test" }],
			})

			yield* dispatchDelivery(
				context,
				"{}",
				respondWith(() => new Response("", { status: 200 })),
				5_000,
				"https://web.localhost/alerts",
				"https://web.localhost/chat",
				{ ...deps(), sendEmail: () => Effect.void },
			).pipe(Effect.withTracer(tracer))

			assert.deepStrictEqual(spansNamed(spans, HTTP_SPAN), [])
		}),
	)
})
