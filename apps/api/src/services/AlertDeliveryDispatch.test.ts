import type { AlertDestinationRow } from "@maple/db"
import { AlertDeliveryError, AlertDestinationId } from "@maple/domain/http"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import {
	buildAlertChatUrl,
	buildDiscordEmbedsFromTemplate,
	buildSlackBlocks,
	buildSlackBlocksFromTemplate,
	buildSlackFallbackText,
	buildTemplateContext,
	dispatchDelivery,
	type DispatchContext,
	type DispatchDeps,
	type TemplateRenderContext,
} from "./AlertDeliveryDispatch"
import { renderTemplate } from "./alert-templating/renderer"
import { DEFAULT_BODY_TEMPLATE, DEFAULT_TITLE_TEMPLATE } from "./alert-templating/defaultTemplates"

const baseContext: TemplateRenderContext = {
	ruleId: "rule_1" as TemplateRenderContext["ruleId"],
	ruleName: "Checkout error rate",
	eventType: "trigger",
	severity: "critical",
	signalType: "error_rate",
	comparator: "gt",
	threshold: 0.05,
	thresholdUpper: null,
	value: 0.08,
	sampleCount: 1200,
	groupKey: null,
	windowMinutes: 5,
	incidentId: "inc_1" as TemplateRenderContext["incidentId"],
	incidentStatus: "open",
	dedupeKey: "dedupe_1",
	template: null,
	sentAtMs: Date.parse("2026-06-02T00:00:00.000Z"),
}

/**
 * A range rule (`between`) — the only shape that populates `thresholdUpper`, and
 * therefore the only one that renders the default body's `{{#if thresholdUpper}}`
 * clause and the "inside the …–… range" breach phrase.
 */
const rangeContext: TemplateRenderContext = {
	...baseContext,
	ruleName: "Checkout error-rate band",
	comparator: "between",
	threshold: 0.01,
	thresholdUpper: 0.05,
}

const LINK = "https://web.localhost/alerts"
const CHAT = "https://web.localhost/chat?mode=alert"
const DESTINATION_ID = Schema.decodeUnknownSync(AlertDestinationId)("7c6b5a49-3821-4e0f-9d8c-7b6a59483726")

/** Slack-token resolver that must not be invoked for non-slack-bot destinations. */
const failingSlackToken = () =>
	Effect.fail(
		new AlertDeliveryError({ message: "unexpected resolveSlackBotToken", destinationType: "slack-bot" }),
	)

/** Dispatch deps for non-email destinations — email sends must not happen. */
const noEmailDeps: DispatchDeps = {
	sendEmail: () =>
		Effect.fail(new AlertDeliveryError({ message: "unexpected sendEmail", destinationType: "email" })),
	resolveSlackBotToken: failingSlackToken,
}

describe("buildAlertChatUrl (Ask Maple AI link)", () => {
	it("targets the incident diagnosis page when an incident exists", () => {
		const url = buildAlertChatUrl("https://web.localhost", baseContext)
		assert.isTrue(url.startsWith("https://web.localhost/alerts/incidents/inc_1?alert="), url)
	})

	it("falls back to the chat surface when there is no incident row", () => {
		const url = buildAlertChatUrl("https://web.localhost", { ...baseContext, incidentId: null })
		assert.isTrue(url.startsWith("https://web.localhost/chat?"), url)
		assert.include(url, "mode=alert")
	})
})

describe("buildTemplateContext", () => {
	const ctx = buildTemplateContext(baseContext, LINK, CHAT)

	it("exposes pre-formatted variables", () => {
		assert.strictEqual(ctx["rule.name"], "Checkout error rate")
		assert.strictEqual(ctx.severity, "critical")
		assert.strictEqual(ctx["signal.label"], "Error Rate")
		assert.strictEqual(ctx["event.label"], "Triggered")
		assert.strictEqual(ctx["comparator.label"], ">")
		// error_rate values render as percentages
		assert.strictEqual(ctx.value, "8%")
		assert.strictEqual(ctx.threshold, "5%")
		assert.strictEqual(ctx["observed.summary"], "8% > 5%")
		assert.strictEqual(ctx.window, "5m")
		assert.strictEqual(ctx.group, "all")
		assert.strictEqual(ctx["links.app"], LINK)
		assert.strictEqual(ctx["links.chat"], CHAT)
		assert.strictEqual(ctx.sentAt, "2026-06-02T00:00:00.000Z")
	})

	it("leaves thresholdUpper empty for non-range comparators", () => {
		assert.strictEqual(ctx.thresholdUpper, "")
	})

	it("renders the default templates without any missing variables", () => {
		const title = renderTemplate(DEFAULT_TITLE_TEMPLATE, ctx)
		const body = renderTemplate(DEFAULT_BODY_TEMPLATE, ctx)
		assert.deepStrictEqual(title.missing, [])
		assert.deepStrictEqual(body.missing, [])
		assert.include(title.text, "Checkout error rate")
		assert.include(title.text, "Triggered")
		assert.include(body.text, "Error Rate is *8%* (> 5%) over the last 5m.")
		assert.include(body.text, "*Severity:* critical · *Group:* all")
	})

	describe("range comparators", () => {
		const range = buildTemplateContext(rangeContext, LINK, CHAT)

		it("formats both bounds and the range observed summary", () => {
			assert.strictEqual(range["comparator.label"], "between")
			assert.strictEqual(range.threshold, "1%")
			assert.strictEqual(range.thresholdUpper, "5%")
			assert.strictEqual(range["observed.summary"], "8% between 1% and 5%")
		})

		it("renders the default body's upper-bound clause", () => {
			const body = renderTemplate(DEFAULT_BODY_TEMPLATE, range)
			assert.deepStrictEqual(body.missing, [])
			assert.include(body.text, "Error Rate is *8%* (between 1% and 5%) over the last 5m.")
		})
	})
})

describe("buildSlackBlocks (default format)", () => {
	type HeaderBlock = { type: string; text: { text: string } }
	type SectionBlock = { type: string; text: { text: string }; fields: Array<{ text: string }> }
	type ContextBlock = { type: string; elements: Array<{ text: string }> }

	it("leads with a truncated header and a human-readable summary sentence", () => {
		const blocks = buildSlackBlocks(baseContext, LINK, CHAT)
		const header = blocks[0] as HeaderBlock
		const section = blocks[1] as SectionBlock
		assert.strictEqual(header.type, "header")
		assert.include(header.text.text, "Checkout error rate")
		assert.strictEqual(section.type, "section")
		assert.include(section.text.text, "*Error Rate* is *8%*")
		assert.include(section.text.text, "above the 5% threshold")
		assert.include(section.text.text, "last 5m")
	})

	it("truncates an over-long default header to Slack's 150-char limit", () => {
		const blocks = buildSlackBlocks({ ...baseContext, ruleName: "x".repeat(300) }, LINK, CHAT)
		const header = blocks[0] as HeaderBlock
		assert.isAtMost(header.text.text.length, 150)
	})

	it("pairs the severity color with an emoji + capitalized label", () => {
		const blocks = buildSlackBlocks(baseContext, LINK, CHAT)
		const section = blocks[1] as SectionBlock
		assert.isTrue(section.fields.some((f) => f.text.includes("\u{1F534} Critical")))
	})

	it("omits the group field when the rule has no grouping, escapes it when present", () => {
		const without = (buildSlackBlocks(baseContext, LINK, CHAT)[1] as SectionBlock).fields
		assert.isFalse(without.some((f) => f.text.startsWith("*Group*")))
		const withGroup = (
			buildSlackBlocks({ ...baseContext, groupKey: "checkout<v2>" }, LINK, CHAT)[1] as SectionBlock
		).fields
		const group = withGroup.find((f) => f.text.startsWith("*Group*"))
		assert.isDefined(group)
		assert.include(group!.text, "checkout&lt;v2&gt;")
	})

	it("phrases a resolve event as recovery and includes a local-time timestamp", () => {
		const blocks = buildSlackBlocks({ ...baseContext, eventType: "resolve" }, LINK, CHAT)
		const section = blocks[1] as SectionBlock
		assert.include(section.text.text, "back within its threshold")
		const context = blocks.at(-1) as ContextBlock
		assert.strictEqual(context.type, "context")
		// <!date^…> renders in each viewer's local timezone; ISO fallback for exports.
		assert.include(context.elements[0]!.text, "<!date^1780358400^")
		assert.include(context.elements[0]!.text, "2026-06-02T00:00:00.000Z")
	})

	it("phrases a range breach as inside the band and carries both bounds", () => {
		const section = buildSlackBlocks(rangeContext, LINK, CHAT)[1] as SectionBlock
		assert.include(section.text.text, "*Error Rate* is *8%*")
		assert.include(section.text.text, "inside the 1%–5% range")
		// A resolve on the same rule reports the full band it is back within.
		const resolved = buildSlackBlocks(
			{ ...rangeContext, eventType: "resolve" },
			LINK,
			CHAT,
		)[1] as SectionBlock
		assert.include(resolved.text.text, "back within its threshold (between 1% and 5%)")
	})

	it("styles buttons per Slack guidance — no danger style on navigation links", () => {
		const blocks = buildSlackBlocks(baseContext, LINK, CHAT)
		const actions = blocks.find((b) => (b as { type: string }).type === "actions") as {
			elements: Array<{ style?: string }>
		}
		assert.isDefined(actions)
		assert.isFalse(actions.elements.some((e) => e.style === "danger"))
	})
})

describe("buildSlackFallbackText", () => {
	it("is a complete one-line summary for notification previews, with mrkdwn escaped", () => {
		const text = buildSlackFallbackText({ ...baseContext, ruleName: "Errors <prod> & staging" })
		assert.include(text, "\u{1F6A8}")
		assert.include(text, "Errors &lt;prod&gt; &amp; staging")
		assert.include(text, "Triggered")
		assert.include(text, "Error Rate 8% > 5%")
	})

	it("spells out both bounds for a range rule", () => {
		const text = buildSlackFallbackText(rangeContext)
		assert.include(text, "Error Rate 8% between 1% and 5%")
	})
})

describe("buildSlackBlocksFromTemplate", () => {
	it("renders a header + mrkdwn section + actions, converting markdown links", () => {
		const blocks = buildSlackBlocksFromTemplate(
			"My Title",
			"**bold** and [link](https://x.test)",
			baseContext,
			LINK,
			CHAT,
		)
		const header = blocks[0] as { type: string; text: { text: string } }
		const section = blocks[1] as { type: string; text: { type: string; text: string } }
		assert.strictEqual(header.type, "header")
		assert.strictEqual(header.text.text, "My Title")
		assert.strictEqual(section.type, "section")
		assert.strictEqual(section.text.type, "mrkdwn")
		// **bold** → *bold*, [link](url) → <url|link>
		assert.strictEqual(section.text.text, "*bold* and <https://x.test|link>")
		assert.isTrue(blocks.some((b) => (b as { type: string }).type === "actions"))
	})

	it("truncates an over-long Slack header", () => {
		const long = "x".repeat(200)
		const blocks = buildSlackBlocksFromTemplate(long, "body", baseContext, LINK, CHAT)
		const header = blocks[0] as { text: { text: string } }
		assert.isAtMost(header.text.text.length, 150)
	})

	// The body is author-controlled text rendered into a message the slack-bot
	// destination can post to ANY public channel (`chat:write.public`), so every
	// `<…>` the author typed must land as literal text.
	describe("mrkdwn injection", () => {
		const sectionText = (body: string): string =>
			(buildSlackBlocksFromTemplate("T", body, baseContext, LINK, CHAT)[1] as {
				text: { text: string }
			}).text.text

		it("neutralizes @channel broadcasts and hand-written deceptive links", () => {
			const text = sectionText("<!channel> see <https://evil.test|Open in Maple>")
			assert.strictEqual(
				text,
				"&lt;!channel&gt; see &lt;https://evil.test|Open in Maple&gt;",
			)
			// Nothing the author typed survives as markup.
			assert.notInclude(text, "<!channel>")
			assert.notInclude(text, "<https://evil.test")
		})

		it("neutralizes the other broadcast mentions too", () => {
			for (const broadcast of ["<!here>", "<!everyone>"]) {
				const text = sectionText(`heads up ${broadcast}`)
				assert.notInclude(text, broadcast)
				assert.include(text, "&lt;!")
			}
		})

		it("percent-encodes a pipe in a markdown link target so the URL cannot pose as the label", () => {
			assert.strictEqual(
				sectionText("[t](https://x.test/a|b)"),
				"<https://x.test/a%7Cb|t>",
			)
		})

		it("still renders the links this module builds itself", () => {
			assert.strictEqual(
				sectionText("**bold** [Open](https://web.localhost/alerts?a=1&b=2)"),
				"*bold* <https://web.localhost/alerts?a=1&amp;b=2|Open>",
			)
		})
	})
})

describe("buildDiscordEmbedsFromTemplate", () => {
	it("maps title/body to the embed and color-codes by severity", () => {
		const [embed] = buildDiscordEmbedsFromTemplate("T", "B", baseContext, LINK, CHAT) as Array<{
			title: string
			description: string
			color: number
			url: string
		}>
		assert.strictEqual(embed.title, "T")
		assert.strictEqual(embed.description, "B")
		assert.strictEqual(embed.url, LINK)
		// critical (non-resolve) → red
		assert.strictEqual(embed.color, 0xe01e5a)
	})
})

describe("dispatchDelivery", () => {
	const destinationRow: AlertDestinationRow = {
		id: DESTINATION_ID,
		orgId: "org_1" as AlertDestinationRow["orgId"],
		name: "PagerDuty",
		type: "pagerduty",
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

	const pagerdutyContext: DispatchContext = {
		deliveryKey: "org_1:dest_1:test",
		destination: destinationRow,
		publicConfig: { summary: "Test alert", channelLabel: null },
		secretConfig: { type: "pagerduty", integrationKey: "not-a-valid-routing-key" },
		ruleId: "rule_1",
		ruleName: "Test alert",
		groupKey: null,
		signalType: "throughput",
		severity: "warning",
		comparator: "lt",
		threshold: 1,
		thresholdUpper: null,
		eventType: "test",
		incidentId: null,
		incidentStatus: "resolved",
		dedupeKey: "org_1:dest_1:test",
		windowMinutes: 5,
		value: 0,
		sampleCount: 0,
		template: null,
		sentAtMs: Date.parse("2026-06-02T00:00:00.000Z"),
	}

	it.effect("includes the provider's response body in the delivery error", () =>
		Effect.gen(function* () {
			const body =
				'{"status":"invalid event","message":"Event object is invalid","errors":["routing_key is invalid"]}'
			const fetchFn: typeof fetch = async () => new Response(body, { status: 400 })

			const error = yield* Effect.flip(
				dispatchDelivery(pagerdutyContext, "{}", fetchFn, 5_000, LINK, CHAT, noEmailDeps),
			)

			assert.instanceOf(error, AlertDeliveryError)
			assert.strictEqual(error.destinationType, "pagerduty")
			assert.include(error.message, "PagerDuty delivery failed with 400")
			// The PagerDuty rejection reason is now surfaced instead of swallowed.
			assert.include(error.message, "routing_key is invalid")
		}),
	)

	const slackBotContext: DispatchContext = {
		...pagerdutyContext,
		destination: { ...destinationRow, name: "Slack bot", type: "slack-bot" },
		publicConfig: { summary: "#incidents", channelLabel: "#incidents" },
		secretConfig: { type: "slack-bot", channelId: "C0789CHAN", channelName: "incidents" },
	}

	const slackTokenDeps = (token = "xoxb-test-token"): DispatchDeps => ({
		sendEmail: () =>
			Effect.fail(new AlertDeliveryError({ message: "unexpected sendEmail", destinationType: "email" })),
		resolveSlackBotToken: () => Effect.succeed(token),
	})

	it.effect("slack-bot: posts to chat.postMessage with the resolved bot token + channel", () =>
		Effect.gen(function* () {
			const calls: Array<{ url: string; auth: string | null; body: unknown }> = []
			const fetchFn: typeof fetch = async (input, init) => {
				calls.push({
					url: String(input),
					auth: new Headers(init?.headers).get("authorization"),
					body: JSON.parse(String(init?.body)),
				})
				return new Response(JSON.stringify({ ok: true, ts: "1700000000.000100" }), { status: 200 })
			}

			const result = yield* dispatchDelivery(
				slackBotContext,
				"{}",
				fetchFn,
				5_000,
				LINK,
				CHAT,
				slackTokenDeps(),
			)

			assert.strictEqual(calls.length, 1)
			assert.strictEqual(calls[0]!.url, "https://slack.com/api/chat.postMessage")
			assert.strictEqual(calls[0]!.auth, "Bearer xoxb-test-token")
			assert.strictEqual((calls[0]!.body as { channel: string }).channel, "C0789CHAN")
			// No top-level text — Slack would render it as a duplicate line above
			// the attachment; the notification preview rides in `fallback`.
			assert.isUndefined((calls[0]!.body as { text?: string }).text)
			// Blocks are wrapped in a colored attachment so the severity bar renders.
			const attachments = (
				calls[0]!.body as {
					attachments: Array<{ color: string; fallback: string; blocks: unknown[] }>
				}
			).attachments
			assert.lengthOf(attachments, 1)
			assert.match(attachments[0]!.color, /^#[0-9a-f]{6}$/)
			assert.include(attachments[0]!.fallback, "Test alert")
			assert.isArray(attachments[0]!.blocks)
			assert.strictEqual(result.providerReference, "1700000000.000100")
			assert.strictEqual(result.responseCode, 200)
		}),
	)

	it.effect("slack-bot: surfaces a not_in_channel logical error with an actionable message", () =>
		Effect.gen(function* () {
			const fetchFn: typeof fetch = async () =>
				new Response(JSON.stringify({ ok: false, error: "not_in_channel" }), { status: 200 })

			const error = yield* Effect.flip(
				dispatchDelivery(slackBotContext, "{}", fetchFn, 5_000, LINK, CHAT, slackTokenDeps()),
			)

			assert.instanceOf(error, AlertDeliveryError)
			assert.strictEqual(error.destinationType, "slack-bot")
			assert.include(error.message, "not_in_channel")
			assert.include(error.message, "invite the Maple bot")
		}),
	)

	it.effect("slack-bot: a hung fetch times out via the Clock and fails typed", () =>
		Effect.gen(function* () {
			// Never settles — only the Clock-driven timeoutOrElse can end this.
			const fetchFn: typeof fetch = () => new Promise<Response>(() => {})

			const fiber = yield* Effect.forkChild(
				Effect.flip(
					dispatchDelivery(slackBotContext, "{}", fetchFn, 5_000, LINK, CHAT, slackTokenDeps()),
				),
				{ startImmediately: true },
			)
			yield* TestClock.adjust("6 seconds")
			const error = yield* Fiber.join(fiber)

			assert.instanceOf(error, AlertDeliveryError)
			assert.strictEqual(error.destinationType, "slack-bot")
			assert.include(error.message, "timed out after 5000ms")
		}),
	)

	it.effect("slack-bot: a non-JSON 200 response fails typed", () =>
		Effect.gen(function* () {
			const fetchFn: typeof fetch = async () => new Response("gateway says hi", { status: 200 })

			const error = yield* Effect.flip(
				dispatchDelivery(slackBotContext, "{}", fetchFn, 5_000, LINK, CHAT, slackTokenDeps()),
			)

			assert.instanceOf(error, AlertDeliveryError)
			assert.strictEqual(error.destinationType, "slack-bot")
			assert.include(error.message, "non-JSON response")
		}),
	)

	it.effect("slack-bot: a JSON payload that fails the response schema fails typed", () =>
		Effect.gen(function* () {
			// Valid JSON, but `ok` is a string — SlackPostMessageResponseSchema rejects it.
			const fetchFn: typeof fetch = async () =>
				new Response(JSON.stringify({ ok: "yes", ts: 123 }), { status: 200 })

			const error = yield* Effect.flip(
				dispatchDelivery(slackBotContext, "{}", fetchFn, 5_000, LINK, CHAT, slackTokenDeps()),
			)

			assert.instanceOf(error, AlertDeliveryError)
			assert.strictEqual(error.destinationType, "slack-bot")
			assert.include(error.message, "unexpected response payload")
		}),
	)

	it.effect("slack-bot: an HTTP-level failure surfaces the status and body", () =>
		Effect.gen(function* () {
			const fetchFn: typeof fetch = async () => new Response("upstream exploded", { status: 500 })

			const error = yield* Effect.flip(
				dispatchDelivery(slackBotContext, "{}", fetchFn, 5_000, LINK, CHAT, slackTokenDeps()),
			)

			assert.instanceOf(error, AlertDeliveryError)
			assert.strictEqual(error.destinationType, "slack-bot")
			assert.include(error.message, "Slack delivery failed with 500")
			assert.include(error.message, "upstream exploded")
		}),
	)

	it.effect("slack-bot: fails when the org has no active Slack installation", () =>
		Effect.gen(function* () {
			const fetchFn: typeof fetch = async () => {
				throw new Error("fetch must not be called when token resolution fails")
			}
			const deps: DispatchDeps = {
				sendEmail: () =>
					Effect.fail(
						new AlertDeliveryError({ message: "unexpected sendEmail", destinationType: "email" }),
					),
				resolveSlackBotToken: () =>
					Effect.fail(
						new AlertDeliveryError({
							message: "Slack is not connected for this organization",
							destinationType: "slack-bot",
						}),
					),
			}

			const error = yield* Effect.flip(
				dispatchDelivery(slackBotContext, "{}", fetchFn, 5_000, LINK, CHAT, deps),
			)

			assert.instanceOf(error, AlertDeliveryError)
			assert.include(error.message, "Slack is not connected")
		}),
	)

	const failingFetch: typeof fetch = async () => {
		throw new Error("fetch must not be called for email dispatch")
	}

	const emailContext: DispatchContext = {
		...pagerdutyContext,
		destination: { ...destinationRow, name: "Email", type: "email" },
		secretConfig: {
			type: "email",
			members: [
				{ userId: "user_ops", email: "ops@acme.test", name: "Ops" },
				{ userId: "user_oncall", email: "oncall@acme.test", name: null },
			],
		},
	}

	it.effect("email: sends one email per recipient with the built-in format", () =>
		Effect.gen(function* () {
			const sent: Array<{ to: string; subject: string; html: string }> = []
			const deps: DispatchDeps = {
				sendEmail: (to, subject, html) =>
					Effect.sync(() => {
						sent.push({ to, subject, html })
					}),
				resolveSlackBotToken: () =>
					Effect.fail(
						new AlertDeliveryError({
							message: "resolveSlackBotToken not available in this test",
							destinationType: "slack-bot",
						}),
					),
			}

			const result = yield* dispatchDelivery(emailContext, "{}", failingFetch, 5_000, LINK, CHAT, deps)

			assert.deepStrictEqual(
				sent.map((s) => s.to),
				["ops@acme.test", "oncall@acme.test"],
			)
			assert.include(sent[0]!.subject, "Test alert")
			assert.include(sent[0]!.subject, "Test")
			assert.include(sent[0]!.html, "Test alert")
			assert.include(sent[0]!.html, LINK)
			assert.include(sent[0]!.html, CHAT)
			assert.strictEqual(result.providerMessage, "Emailed 2 members")
			assert.strictEqual(result.responseCode, null)
		}),
	)

	it.effect("email: surfaces a send failure as an email delivery error", () =>
		Effect.gen(function* () {
			const deps: DispatchDeps = {
				sendEmail: () =>
					Effect.fail(
						new AlertDeliveryError({
							message: "Email not configured: EMAIL binding is missing",
							destinationType: "email",
						}),
					),
				resolveSlackBotToken: failingSlackToken,
			}

			const error = yield* Effect.flip(
				dispatchDelivery(emailContext, "{}", failingFetch, 5_000, LINK, CHAT, deps),
			)

			assert.instanceOf(error, AlertDeliveryError)
			assert.strictEqual(error.destinationType, "email")
			assert.include(error.message, "EMAIL binding is missing")
		}),
	)

	it.effect("email: succeeds with annotation when only some members fail", () =>
		Effect.gen(function* () {
			const sent: string[] = []
			const deps: DispatchDeps = {
				sendEmail: (to) =>
					to === "oncall@acme.test"
						? Effect.fail(
								new AlertDeliveryError({
									message: "mailbox unavailable",
									destinationType: "email",
								}),
							)
						: Effect.sync(() => {
								sent.push(to)
							}),
				resolveSlackBotToken: failingSlackToken,
			}

			const result = yield* dispatchDelivery(emailContext, "{}", failingFetch, 5_000, LINK, CHAT, deps)

			assert.deepStrictEqual(sent, ["ops@acme.test"])
			assert.include(result.providerMessage, "Emailed 1 of 2 members")
			assert.include(result.providerMessage, "oncall@acme.test")
			assert.include(result.providerMessage, "mailbox unavailable")
		}),
	)

	it.effect("email: fails with the first member error when every member fails", () =>
		Effect.gen(function* () {
			const deps: DispatchDeps = {
				sendEmail: () =>
					Effect.fail(
						new AlertDeliveryError({
							message: "Cloudflare Email send timed out after 15s",
							destinationType: "email",
						}),
					),
				resolveSlackBotToken: failingSlackToken,
			}

			const error = yield* Effect.flip(
				dispatchDelivery(emailContext, "{}", failingFetch, 5_000, LINK, CHAT, deps),
			)

			assert.instanceOf(error, AlertDeliveryError)
			assert.include(error.message, "failed for all 2 members")
			// The verbatim member error must survive aggregation so retryability
			// classification (timeout detection) keeps working upstream.
			assert.include(error.message, "timed out")
		}),
	)
})
