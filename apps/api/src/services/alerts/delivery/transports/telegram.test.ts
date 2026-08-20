import type { AlertDestinationRow } from "@maple/db"
import { AlertDestinationId } from "@maple/domain/http"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import type { DispatchContext } from "../context"
import type { RenderInput, SecretConfigOf } from "../Transport"
import { TELEGRAM_BOT_TOKEN_PATTERN, telegramTransport, verifyTelegramCredentials } from "./telegram"

const DESTINATION_ID = Schema.decodeUnknownSync(AlertDestinationId)("7c6b5a49-3821-4e0f-9d8c-7b6a59483726")

const BOT_TOKEN = "123456789:AAHqwertyuiopasdfghjklzxcvbnm123456"
const CHAT_ID = "-1001234567890"
const LINK = "https://web.localhost/alerts"
const CHAT = "https://web.localhost/chat"

const destinationRow: AlertDestinationRow = {
	id: DESTINATION_ID,
	orgId: "org_1" as AlertDestinationRow["orgId"],
	name: "On-call Telegram",
	type: "telegram",
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

const config: SecretConfigOf<"telegram"> = { type: "telegram", botToken: BOT_TOKEN, chatId: CHAT_ID }

const makeContext = (overrides: Partial<DispatchContext> = {}): DispatchContext => ({
	deliveryKey: "org_1:dest_1:delivery",
	destination: destinationRow,
	publicConfig: { summary: `Chat ${CHAT_ID}`, channelLabel: CHAT_ID },
	secretConfig: config,
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
	...overrides,
})

const inputFor = (overrides: Partial<RenderInput<typeof config>> = {}): RenderInput<typeof config> => ({
	config,
	context: makeContext(),
	linkUrl: LINK,
	chatUrl: CHAT,
	payloadJson: '{"canonical":"payload"}',
	templated: null,
	...overrides,
})

/**
 * Decoded rather than cast: the point of these cases is that the wire body has
 * a particular shape, so asserting it is the test, not a formality.
 */
const SendMessageBody = Schema.Struct({
	chat_id: Schema.String,
	text: Schema.String,
	parse_mode: Schema.String,
	link_preview_options: Schema.Record(Schema.String, Schema.Unknown),
	reply_markup: Schema.Struct({
		inline_keyboard: Schema.Array(
			Schema.Array(Schema.Struct({ text: Schema.String, url: Schema.String })),
		),
	}),
})
const decodeSendMessageBody = Schema.decodeUnknownSync(Schema.fromJsonString(SendMessageBody))

const render = (input: RenderInput<typeof config> = inputFor()) => {
	const spec = telegramTransport.render(input, undefined)
	return { spec, body: decodeSendMessageBody(spec.body) }
}

describe("telegramTransport.render", () => {
	it("posts to sendMessage with the token in the path and the chat in the body", () => {
		const { spec, body } = render()
		assert.strictEqual(spec.url, `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`)
		assert.strictEqual(body.chat_id, CHAT_ID)
		assert.strictEqual(body.parse_mode, "HTML")
		// The token must never reach the body or a header — only the path, which
		// `sensitivePath` keeps off the span.
		assert.isFalse(spec.body.includes(BOT_TOKEN))
		assert.isFalse(JSON.stringify(spec.headers).includes(BOT_TOKEN))
	})

	it("carries both links as inline keyboard buttons", () => {
		const [row] = render().body.reply_markup.inline_keyboard
		assert.deepStrictEqual(
			row?.map((button) => button.url),
			[LINK, CHAT],
		)
	})

	/**
	 * The reason `parse_mode: "HTML"` needs escaping is not only injection:
	 * `formatThresholdSummary` legitimately emits `> 5%`, which Telegram reads as
	 * an unclosed tag and rejects the whole message with 400.
	 */
	it("escapes the threshold comparator so HTML mode can parse the message", () => {
		const { text } = render(inputFor({ context: makeContext({ eventType: "resolve" }) })).body
		assert.include(text, "&gt;")
		assert.isFalse(/<(?!\/?(?:b|i|code|pre|a|s|u)\b)/.test(text), text)
	})

	it("escapes HTML metacharacters in the rule name", () => {
		const input = inputFor({ context: makeContext({ ruleName: "<b>Pwn</b> & co" }) })
		const { text } = render(input).body
		assert.include(text, "&lt;b&gt;Pwn&lt;/b&gt; &amp; co")
		assert.isFalse(text.includes("<b>Pwn"))
	})

	it("previews the chart when there is one, and nothing otherwise", () => {
		assert.deepStrictEqual(render().body.link_preview_options, { is_disabled: true })
		const withChart = render(
			inputFor({ context: makeContext({ chartUrl: "https://maple.dev/c/abc.png" }) }),
		)
		assert.deepStrictEqual(withChart.body.link_preview_options, {
			url: "https://maple.dev/c/abc.png",
			show_above_text: true,
		})
	})

	describe("templated bodies", () => {
		it("converts Markdown emphasis and links to Telegram's tag subset", () => {
			const { text } = render(
				inputFor({
					templated: { title: "Custom title", body: "Custom **body** [Open](https://maple.dev/x)" },
				}),
			).body
			assert.include(text, "<b>Custom title</b>")
			assert.include(text, "<b>body</b>")
			assert.include(text, '<a href="https://maple.dev/x">Open</a>')
		})

		it("leaves a non-http link target as inert text", () => {
			const { text } = render(
				inputFor({ templated: { title: "T", body: "[Tap](tg://user?id=1)" } }),
			).body
			assert.isFalse(text.includes("<a href"))
			assert.include(text, "[Tap](tg://user?id=1)")
		})

		it("caps the text at Telegram's 4096-character limit", () => {
			const { text } = render(inputFor({ templated: { title: "T", body: "x".repeat(9000) } })).body
			assert.isAtMost(text.length, 4096)
		})
	})
})

describe("telegramTransport.interpret", () => {
	const interpret = (raw: string) => telegramTransport.interpret!(inputFor(), raw)

	it("reads the message id off a successful send", () => {
		const result = interpret(JSON.stringify({ ok: true, result: { message_id: 42 } }))
		assert.isTrue(Result.isSuccess(result))
		if (Result.isSuccess(result)) assert.strictEqual(result.success.providerReference, "42")
	})

	/**
	 * Telegram reports logical failures as HTTP 200 + `{ ok: false }`, so the
	 * runner's status classifier never sees them — retryability is decided here
	 * or not at all.
	 */
	it.each([
		[401, "AlertDeliveryAuthError", false],
		[403, "AlertDeliveryTargetMissingError", false],
		[400, "AlertDeliveryRejectedError", false],
		[429, "AlertDeliveryError", true],
	] as const)("classifies error_code %i as %s", (errorCode, name, retryable) => {
		const result = interpret(
			JSON.stringify({ ok: false, error_code: errorCode, description: "Forbidden: bot was kicked" }),
		)
		assert.isTrue(Result.isFailure(result))
		if (Result.isFailure(result)) {
			assert.strictEqual(result.failure._tag, `@maple/http/errors/${name}`)
			assert.strictEqual(result.failure.error.retryable, retryable)
		}
	})

	it("fails rather than claiming delivery on a non-JSON response", () => {
		assert.isTrue(Result.isFailure(interpret("<html>502</html>")))
	})
})

describe("TELEGRAM_BOT_TOKEN_PATTERN", () => {
	it("accepts a @BotFather token and rejects the usual wrong pastes", () => {
		assert.isTrue(TELEGRAM_BOT_TOKEN_PATTERN.test(BOT_TOKEN))
		assert.isFalse(TELEGRAM_BOT_TOKEN_PATTERN.test(`bot${BOT_TOKEN}`))
		assert.isFalse(TELEGRAM_BOT_TOKEN_PATTERN.test(CHAT_ID))
		assert.isFalse(TELEGRAM_BOT_TOKEN_PATTERN.test("123456789:short"))
	})
})

describe("verifyTelegramCredentials", () => {
	const stub = (responses: ReadonlyArray<{ status: number; body: unknown }>) => {
		const calls: string[] = []
		let index = 0
		const fetchFn: typeof fetch = async (input) => {
			calls.push(String(input))
			const next = responses[Math.min(index++, responses.length - 1)]!
			return new Response(JSON.stringify(next.body), {
				status: next.status,
				headers: { "content-type": "application/json" },
			})
		}
		return { fetchFn, calls }
	}

	const ok = { status: 200, body: { ok: true, result: {} } }

	it.effect("is valid when both getMe and getChat succeed", () =>
		Effect.gen(function* () {
			const { fetchFn, calls } = stub([ok, ok])
			const result = yield* verifyTelegramCredentials(BOT_TOKEN, CHAT_ID, fetchFn, 1000)
			assert.deepStrictEqual(result, { status: "valid" })
			assert.strictEqual(calls.length, 2)
			assert.include(calls[1]!, `chat_id=${encodeURIComponent(CHAT_ID)}`)
		}),
	)

	it.effect("rejects a bad token without asking about the chat", () =>
		Effect.gen(function* () {
			const { fetchFn, calls } = stub([{ status: 401, body: { ok: false, error_code: 401 } }])
			const result = yield* verifyTelegramCredentials(BOT_TOKEN, CHAT_ID, fetchFn, 1000)
			assert.strictEqual(result.status, "invalid")
			assert.strictEqual(calls.length, 1)
		}),
	)

	/** The dominant misconfiguration: a real token aimed at a chat the bot was never added to. */
	it.effect("rejects a chat the bot cannot reach, quoting Telegram's reason", () =>
		Effect.gen(function* () {
			const { fetchFn } = stub([
				ok,
				{
					status: 400,
					body: { ok: false, error_code: 400, description: "Bad Request: chat not found" },
				},
			])
			const result = yield* verifyTelegramCredentials(BOT_TOKEN, CHAT_ID, fetchFn, 1000)
			assert.strictEqual(result.status, "invalid")
			if (result.status === "invalid") assert.include(result.reason, "chat not found")
		}),
	)

	it.effect("fails open on a 5xx so a Telegram outage cannot block a save", () =>
		Effect.gen(function* () {
			const { fetchFn } = stub([{ status: 503, body: {} }])
			const result = yield* verifyTelegramCredentials(BOT_TOKEN, CHAT_ID, fetchFn, 1000)
			assert.deepStrictEqual(result, { status: "unknown" })
		}),
	)

	it.effect("fails open when the request throws", () =>
		Effect.gen(function* () {
			const fetchFn: typeof fetch = () => Promise.reject(new Error("network down"))
			const result = yield* verifyTelegramCredentials(BOT_TOKEN, CHAT_ID, fetchFn, 1000)
			assert.deepStrictEqual(result, { status: "unknown" })
		}),
	)
})
