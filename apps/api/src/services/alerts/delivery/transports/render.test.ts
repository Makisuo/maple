import type { AlertDestinationRow } from "@maple/db"
import { AlertDestinationId } from "@maple/domain/http"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import type { DispatchContext } from "../context"
import type { HttpRequestSpec, RenderInput } from "../Transport"
import { discordTransport } from "./discord"
import { hazelTransport } from "./hazel"
import { pagerDutyTransport } from "./pagerduty"
import { makeSlackTransport } from "./slack"
import { webhookTransport } from "./webhook"

/**
 * `render` is pure — no Effect, no fetch, no Clock — so a provider's wire shape
 * is assertable as a plain function call with no stub of any kind. That is the
 * point of the transport split: these cases used to need a fetch stub, a
 * destination row and a full deps bag each, which is why four of the six
 * providers had no coverage at all.
 */

const DESTINATION_ID = Schema.decodeUnknownSync(AlertDestinationId)("7c6b5a49-3821-4e0f-9d8c-7b6a59483726")

const LINK = "https://web.localhost/alerts"
const CHAT = "https://web.localhost/chat"

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

const context: DispatchContext = {
	deliveryKey: "org_1:dest_1:delivery",
	destination: destinationRow,
	publicConfig: { summary: "Checkout error rate", channelLabel: null },
	secretConfig: { type: "webhook", url: "https://unused.test", signingSecret: null },
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
	sentAtMs: Date.parse("2026-06-02T00:00:00.000Z"),
}

const inputFor = <Config>(
	config: Config,
	overrides: Partial<RenderInput<Config>> = {},
): RenderInput<Config> => ({
	config,
	context,
	linkUrl: LINK,
	chatUrl: CHAT,
	payloadJson: '{"canonical":"payload"}',
	templated: null,
	...overrides,
})

const TEMPLATED = { title: "Custom title", body: "Custom **body**" }

describe("transport render: guard flags", () => {
	/**
	 * `guarded` decides whether the request goes through the SSRF guard, and
	 * `sensitivePath` decides whether the URL path may appear on a span. Both are
	 * a function of where the host came from, so a provider getting either wrong
	 * is either an SSRF hole or a token leak into telemetry.
	 */
	const specs: ReadonlyArray<readonly [string, HttpRequestSpec]> = [
		[
			"slack-bot",
			makeSlackTransport({ resolveSlackBotToken: () => Effect.succeed("t") }).render(
				inputFor({ type: "slack-bot", channelId: "C1", channelName: "ops" }),
				"xoxb-token",
			),
		],
		["pagerduty", pagerDutyTransport.render(inputFor({ type: "pagerduty", integrationKey: "k" }))],
		[
			"webhook",
			webhookTransport.render(
				inputFor({ type: "webhook", url: "https://hooks.test/x", signingSecret: null }),
			),
		],
		[
			"discord",
			discordTransport.render(
				inputFor({ type: "discord", webhookUrl: "https://discord.com/api/w/1/tok" }),
			),
		],
		[
			"hazel-oauth",
			hazelTransport.render(
				inputFor({
					type: "hazel-oauth",
					hazelOrganizationId: "o",
					hazelOrganizationName: "Acme",
					hazelChannelId: "c",
					hazelChannelName: "ops",
					webhookId: "w",
					webhookUrl: "https://hazel.test/api/webhooks/w/tok",
					webhookToken: "tok",
				}),
			),
		],
	]

	it("guards exactly the user-configured hosts", () => {
		const guarded = specs.filter(([, spec]) => spec.guarded).map(([name]) => name)
		// slack + pagerduty post to compile-time vendor constants: there is no
		// attacker-controlled URL to validate, so the guard would only cost a
		// redirect walk.
		assert.deepStrictEqual(guarded, ["webhook", "discord", "hazel-oauth"])
	})

	it("marks exactly the providers whose token rides in the URL path", () => {
		const sensitive = specs.filter(([, spec]) => spec.sensitivePath).map(([name]) => name)
		assert.deepStrictEqual(sensitive, ["discord", "hazel-oauth"])
	})

	it("always produces a parseable JSON body", () => {
		for (const [name, spec] of specs) {
			assert.doesNotThrow(() => JSON.parse(spec.body), `${name} body must be JSON`)
		}
	})

	it("is deterministic — no Clock, no randomness in a render", () => {
		const render = () => pagerDutyTransport.render(inputFor({ type: "pagerduty", integrationKey: "k" }))
		assert.deepStrictEqual(render(), render())
	})
})

describe("transport render: templates", () => {
	it("slack-bot puts the template title in the header and the body in a section", () => {
		const spec = makeSlackTransport({ resolveSlackBotToken: () => Effect.succeed("t") }).render(
			inputFor({ type: "slack-bot", channelId: "C1", channelName: "ops" }, { templated: TEMPLATED }),
			"xoxb-token",
		)
		const body = JSON.parse(spec.body)
		const blocks = body.attachments[0].blocks
		assert.strictEqual(blocks[0].text.text, "Custom title")
		// Markdown is rewritten to Slack mrkdwn: **b** → *b*.
		assert.strictEqual(blocks[1].text.text, "Custom *body*")
		// The notification preview falls back to the template title.
		assert.strictEqual(body.attachments[0].fallback, "Custom title")
	})

	it("discord uses the template title for both the content line and the embed", () => {
		const spec = discordTransport.render(
			inputFor(
				{ type: "discord", webhookUrl: "https://discord.com/api/w/1/tok" },
				{ templated: TEMPLATED },
			),
		)
		const body = JSON.parse(spec.body)
		assert.strictEqual(body.content, "Custom title")
		assert.strictEqual(body.embeds[0].title, "Custom title")
		assert.strictEqual(body.embeds[0].description, "Custom **body**")
	})

	it("pagerduty takes only the summary and a custom_details message from a template", () => {
		const spec = pagerDutyTransport.render(
			inputFor({ type: "pagerduty", integrationKey: "k" }, { templated: TEMPLATED }),
		)
		const body = JSON.parse(spec.body)
		assert.strictEqual(body.payload.summary, "Custom title")
		assert.strictEqual(body.payload.custom_details.message, "Custom **body**")
		// The envelope is fixed by the Events v2 API — a template cannot reshape it.
		assert.strictEqual(body.event_action, "trigger")
		assert.strictEqual(body.routing_key, "k")
	})

	it("webhook and hazel ignore templates — they ship the canonical payload", () => {
		for (const spec of [
			webhookTransport.render(
				inputFor(
					{ type: "webhook", url: "https://hooks.test/x", signingSecret: null },
					{ templated: TEMPLATED },
				),
			),
			hazelTransport.render(
				inputFor(
					{
						type: "hazel-oauth",
						hazelOrganizationId: "o",
						hazelOrganizationName: "Acme",
						hazelChannelId: "c",
						hazelChannelName: "ops",
						webhookId: "w",
						webhookUrl: "https://hazel.test/api/webhooks/w/tok",
						webhookToken: "tok",
					},
					{ templated: TEMPLATED },
				),
			),
		]) {
			assert.strictEqual(spec.body, '{"canonical":"payload"}')
		}
	})
})

describe("transport render: event types", () => {
	for (const eventType of ["trigger", "resolve", "test"] as const) {
		it(`every provider renders a ${eventType} event without throwing`, () => {
			const withEvent = { context: { ...context, eventType } }
			assert.doesNotThrow(() => {
				pagerDutyTransport.render(inputFor({ type: "pagerduty", integrationKey: "k" }, withEvent))
				webhookTransport.render(
					inputFor(
						{ type: "webhook", url: "https://hooks.test/x", signingSecret: null },
						withEvent,
					),
				)
				discordTransport.render(
					inputFor({ type: "discord", webhookUrl: "https://discord.com/api/w/1/tok" }, withEvent),
				)
				makeSlackTransport({ resolveSlackBotToken: () => Effect.succeed("t") }).render(
					inputFor({ type: "slack-bot", channelId: "C1", channelName: "ops" }, withEvent),
					"xoxb-token",
				)
			})
		})
	}
})
