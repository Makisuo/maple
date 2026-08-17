import type { AlertDestinationRow } from "@maple/db"
import { AlertDeliveryError, AlertDestinationId } from "@maple/domain/http"
import { assert, describe, it } from "@effect/vitest"
import { createHmac } from "node:crypto"
import { Effect, Schema } from "effect"
import type { DispatchContext } from "./AlertDeliveryDispatch"
import { dispatchDelivery, type DispatchDeps } from "./delivery/dispatch"

/**
 * Characterization tests: they pin what each provider ACTUALLY sends today,
 * before the delivery layer is restructured onto a transport registry.
 *
 * `discord`, `pagerduty`, `webhook` and `hazel-oauth` had no direct dispatch
 * coverage at all — every dispatch test targeted slack-bot or email — so a
 * refactor had nothing to refactor against. These are deliberately literal
 * (exact URL, exact headers, exact parsed body) rather than
 * behaviour-describing: their job is to make any change to the wire show up as
 * a reviewable diff.
 *
 * Where today's behaviour is a known defect, the assertion pins the DEFECT and
 * says so. Normalizing those is a later, explicit stage.
 */

const DESTINATION_ID = Schema.decodeUnknownSync(AlertDestinationId)("7c6b5a49-3821-4e0f-9d8c-7b6a59483726")

const SENT_AT_MS = Date.parse("2026-06-02T00:00:00.000Z")
const LINK = "https://web.localhost/alerts"
const CHAT = "https://web.localhost/chat?mode=alert"

const destinationRow = (overrides: Partial<AlertDestinationRow> = {}): AlertDestinationRow => ({
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
	...overrides,
})

/** A breaching error-rate alert — the shape every provider renders from. */
const contextFor = (secretConfig: DispatchContext["secretConfig"]): DispatchContext => ({
	deliveryKey: "org_1:dest_1:delivery",
	destination: destinationRow({ type: secretConfig.type }),
	publicConfig: { summary: "Checkout error rate", channelLabel: null },
	secretConfig,
	ruleId: "rule_1",
	ruleName: "Checkout error rate",
	groupKey: "checkout",
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
	sentAtMs: SENT_AT_MS,
})

/** Neither dep may be invoked by these four providers. */
const noDeps: DispatchDeps = {
	sendEmail: () =>
		Effect.fail(new AlertDeliveryError({ message: "unexpected sendEmail", destinationType: "email" })),
	resolveSlackBotToken: () =>
		Effect.fail(
			new AlertDeliveryError({
				message: "unexpected resolveSlackBotToken",
				destinationType: "slack-bot",
			}),
		),
}

interface RecordedCall {
	readonly url: string
	readonly method: string
	readonly headers: Headers
	readonly body: string
}

/** Captures the outbound request and replies with `response`. */
const recorder = (response: () => Response) => {
	const calls: Array<RecordedCall> = []
	const fetchFn: typeof fetch = async (input, init) => {
		calls.push({
			url: String(input),
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			body: String(init?.body ?? ""),
		})
		return response()
	}
	return { calls, fetchFn }
}

const ok = () => new Response("", { status: 200 })

const dispatch = (context: DispatchContext, fetchFn: typeof fetch, payloadJson = "{}") =>
	dispatchDelivery(context, payloadJson, fetchFn, 5_000, LINK, CHAT, noDeps)

/* -------------------------------------------------------------------------- */

describe("dispatchDelivery: pagerduty", () => {
	const context = contextFor({ type: "pagerduty", integrationKey: "R0UT1NGK3Y" })

	it.effect("posts an Events v2 trigger envelope to the fixed vendor host", () =>
		Effect.gen(function* () {
			const { calls, fetchFn } = recorder(ok)
			const result = yield* dispatch(context, fetchFn)

			assert.lengthOf(calls, 1)
			const call = calls[0]!
			assert.strictEqual(call.url, "https://events.pagerduty.com/v2/enqueue")
			assert.strictEqual(call.method, "POST")
			assert.strictEqual(call.headers.get("content-type"), "application/json")

			const body = JSON.parse(call.body)
			assert.strictEqual(body.routing_key, "R0UT1NGK3Y")
			assert.strictEqual(body.event_action, "trigger")
			assert.strictEqual(body.dedup_key, "org_1:rule_1:checkout")
			assert.strictEqual(body.payload.summary, "Checkout error rate trigger")
			assert.strictEqual(body.payload.source, "checkout")
			assert.strictEqual(body.payload.severity, "critical")
			assert.deepStrictEqual(body.links, [
				{ href: LINK, text: "Open in Maple" },
				{ href: CHAT, text: "Ask Maple AI" },
			])
			// custom_details carries RAW numbers, not the formatted strings the chat
			// providers render — a PagerDuty payload is machine-facing.
			assert.strictEqual(body.payload.custom_details.value, 0.08)
			assert.strictEqual(body.payload.custom_details.threshold, 0.05)
			assert.strictEqual(body.payload.custom_details.signalType, "error_rate")

			assert.deepStrictEqual(result, {
				providerMessage: "Delivered to PagerDuty",
				providerReference: "org_1:rule_1:checkout",
				responseCode: 200,
			})
		}),
	)

	it.effect("maps a resolve event to event_action resolve on the same dedup key", () =>
		Effect.gen(function* () {
			const { calls, fetchFn } = recorder(ok)
			yield* dispatch({ ...context, eventType: "resolve" }, fetchFn)

			const body = JSON.parse(calls[0]!.body)
			assert.strictEqual(body.event_action, "resolve")
			assert.strictEqual(body.dedup_key, "org_1:rule_1:checkout")
		}),
	)

	it.effect("collapses a warning severity to PagerDuty's warning level", () =>
		Effect.gen(function* () {
			const { calls, fetchFn } = recorder(ok)
			yield* dispatch({ ...context, severity: "warning" }, fetchFn)

			assert.strictEqual(JSON.parse(calls[0]!.body).payload.severity, "warning")
		}),
	)
})

describe("dispatchDelivery: webhook", () => {
	const url = "https://hooks.example.test/maple"

	it.effect("ships the caller's payload verbatim with the maple headers", () =>
		Effect.gen(function* () {
			const { calls, fetchFn } = recorder(ok)
			const payloadJson = '{"eventType":"trigger","rule":{"id":"rule_1"}}'
			const result = yield* dispatch(
				contextFor({ type: "webhook", url, signingSecret: null }),
				fetchFn,
				payloadJson,
			)

			assert.lengthOf(calls, 1)
			const call = calls[0]!
			assert.strictEqual(call.url, url)
			assert.strictEqual(call.method, "POST")
			// Byte-identical: the webhook body IS the caller's payload string.
			assert.strictEqual(call.body, payloadJson)
			assert.strictEqual(call.headers.get("content-type"), "application/json")
			assert.strictEqual(call.headers.get("x-maple-event-type"), "trigger")
			assert.strictEqual(call.headers.get("x-maple-delivery-key"), "org_1:dest_1:delivery")
			assert.isNull(call.headers.get("x-maple-signature"))

			assert.deepStrictEqual(result, {
				providerMessage: "Delivered to webhook",
				providerReference: "org_1:rule_1:checkout",
				responseCode: 200,
			})
		}),
	)

	it.effect("signs the exact payload bytes with HMAC-SHA256 when a secret is set", () =>
		Effect.gen(function* () {
			const { calls, fetchFn } = recorder(ok)
			const payloadJson = '{"eventType":"trigger"}'
			yield* dispatch(
				contextFor({ type: "webhook", url, signingSecret: "s3cr3t" }),
				fetchFn,
				payloadJson,
			)

			const signature = calls[0]!.headers.get("x-maple-signature")
			assert.isNotNull(signature)
			// Pinned: consumers verify against this exact construction.
			assert.strictEqual(signature, createHmac("sha256", "s3cr3t").update(payloadJson).digest("hex"))
		}),
	)

	it.effect("surfaces the upstream status and body on failure", () =>
		Effect.gen(function* () {
			const { fetchFn } = recorder(() => new Response("upstream exploded", { status: 500 }))
			const error = yield* Effect.flip(
				dispatch(contextFor({ type: "webhook", url, signingSecret: null }), fetchFn),
			)

			assert.strictEqual(error.destinationType, "webhook")
			assert.include(error.message, "Webhook delivery failed with 500")
			assert.include(error.message, "upstream exploded")
		}),
	)
})

describe("dispatchDelivery: discord", () => {
	const webhookUrl = "https://discord.com/api/webhooks/1234567890/tok3n-in-the-path"
	const context = contextFor({ type: "discord", webhookUrl })

	it.effect("posts a username + content line + one embed to the configured webhook", () =>
		Effect.gen(function* () {
			const { calls, fetchFn } = recorder(ok)
			const result = yield* dispatch(context, fetchFn)

			assert.lengthOf(calls, 1)
			const call = calls[0]!
			assert.strictEqual(call.url, webhookUrl)
			assert.strictEqual(call.method, "POST")
			assert.strictEqual(call.headers.get("content-type"), "application/json")

			const body = JSON.parse(call.body)
			assert.strictEqual(body.username, "Maple Alerts")
			assert.strictEqual(body.content, "**Checkout error rate**: Triggered")
			assert.lengthOf(body.embeds, 1)
			const embed = body.embeds[0]
			assert.strictEqual(embed.url, LINK)
			assert.strictEqual(embed.color, 0xe01e5a)
			const fieldNames = embed.fields.map((f: { name: string }) => f.name)
			assert.deepStrictEqual(fieldNames, ["Severity", "Signal", "Group", "Observed", "Window", "Links"])

			// NORMALIZED: Discord used to be the only provider returning no
			// provider reference, so its delivery rows had nothing to correlate
			// against. Discord's plain webhook POST returns an empty body, so there
			// is no message id to quote — it now reports the dedupe key, the same
			// correlation handle pagerduty/webhook/hazel use.
			assert.deepStrictEqual(result, {
				providerMessage: "Delivered to Discord",
				providerReference: "org_1:rule_1:checkout",
				responseCode: 200,
			})
		}),
	)

	it.effect("does not read the caller's payload json", () =>
		Effect.gen(function* () {
			const { calls, fetchFn } = recorder(ok)
			yield* dispatch(context, fetchFn, '{"totally":"ignored"}')

			assert.notInclude(calls[0]!.body, "totally")
		}),
	)
})

describe("dispatchDelivery: hazel-oauth", () => {
	const config = {
		type: "hazel-oauth" as const,
		hazelOrganizationId: "org_hz",
		hazelOrganizationName: "Acme",
		hazelChannelId: "chan_hz",
		hazelChannelName: "incidents",
		webhookId: "wh_1",
		webhookUrl: "https://hazel.test/api/webhooks/wh_1/tok3n-in-the-path",
		webhookToken: "tok3n-in-the-path",
	}
	const context = contextFor(config)

	it.effect("appends /maple to the stored webhook url", () =>
		Effect.gen(function* () {
			const { calls, fetchFn } = recorder(ok)
			const result = yield* dispatch(context, fetchFn)

			assert.strictEqual(calls[0]!.url, `${config.webhookUrl}/maple`)
			assert.strictEqual(calls[0]!.headers.get("x-maple-event-type"), "trigger")
			assert.strictEqual(calls[0]!.headers.get("x-maple-delivery-key"), "org_1:dest_1:delivery")
			assert.deepStrictEqual(result, {
				providerMessage: "Delivered to Hazel #incidents",
				providerReference: "org_1:rule_1:checkout",
				responseCode: 200,
			})
		}),
	)

	it.effect("tolerates a trailing slash on the stored url", () =>
		Effect.gen(function* () {
			const { calls, fetchFn } = recorder(ok)
			yield* dispatch(contextFor({ ...config, webhookUrl: `${config.webhookUrl}/` }), fetchFn)

			assert.strictEqual(calls[0]!.url, `${config.webhookUrl}/maple`)
		}),
	)

	/**
	 * NORMALIZED. Hazel used to build its own near-copy of the wire payload, and
	 * it had drifted: `thresholdUpper` was dropped entirely and `incidentStatus`
	 * was recomputed from `eventType` rather than carried. It now ships the
	 * canonical payload, exactly like the webhook destination, so there is only
	 * one wire contract to keep correct.
	 */
	it.effect("ships the canonical wire payload rather than a hand-built copy", () =>
		Effect.gen(function* () {
			const { calls, fetchFn } = recorder(ok)
			const payloadJson = '{"canonical":"payload","incidentStatus":"acknowledged"}'
			yield* dispatch(
				{ ...context, incidentStatus: "acknowledged", thresholdUpper: 0.5 },
				fetchFn,
				payloadJson,
			)

			assert.strictEqual(calls[0]!.body, payloadJson)
		}),
	)

	it.effect("maps 401/403 to an actionable reconfigure message", () =>
		Effect.gen(function* () {
			for (const status of [401, 403]) {
				const { fetchFn } = recorder(() => new Response("", { status }))
				const error = yield* Effect.flip(dispatch(context, fetchFn))
				assert.strictEqual(error.destinationType, "hazel-oauth")
				assert.include(error.message, "reconfigure the channel")
			}
		}),
	)

	it.effect("maps 404 to a pick-a-different-channel message", () =>
		Effect.gen(function* () {
			const { fetchFn } = recorder(() => new Response("", { status: 404 }))
			const error = yield* Effect.flip(dispatch(context, fetchFn))
			assert.include(error.message, "no longer exists")
		}),
	)
})
