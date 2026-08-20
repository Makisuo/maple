// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
import {
	AlertDeliveryAuthError,
	AlertDeliveryError,
	AlertDeliveryRejectedError,
	AlertDeliveryTargetMissingError,
	type AlertDeliveryFailure,
} from "@maple/domain/http"
import { Duration, Effect, Result, Schema } from "effect"
import { buildTelegramText, buildTelegramTextFromTemplate } from "../../AlertDeliveryDispatch"
import { truncate } from "../../alert-formatting"
import type { HttpTransport, ProviderAck, RenderInput, SecretConfigOf } from "../Transport"

type Config = SecretConfigOf<"telegram">

const TELEGRAM_API_ORIGIN = "https://api.telegram.org"

/**
 * A @BotFather token is `<botId>:<secret>` — a numeric id, a colon, then a
 * ~35-char base64url secret. Checked before the network call so the usual wrong
 * paste (a chat id, or a token with the `bot` prefix left on) gets a specific
 * message instead of a generic 404 from Telegram.
 */
export const TELEGRAM_BOT_TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/

/**
 * Telegram answers HTTP 200 with `{ ok: false, description, error_code }` for
 * logical failures — the same shape of lie Slack tells, so the body is the
 * source of truth, not the status.
 */
const TelegramResponseSchema = Schema.Struct({
	ok: Schema.optionalKey(Schema.Boolean),
	description: Schema.optionalKey(Schema.String),
	error_code: Schema.optionalKey(Schema.Number),
	result: Schema.optionalKey(Schema.Struct({ message_id: Schema.optionalKey(Schema.Number) })),
})
const decodeTelegramResponse = Schema.decodeUnknownResult(TelegramResponseSchema)

const telegramError = (message: string) => new AlertDeliveryError({ message, destinationType: "telegram" })

/**
 * Same policy as `failureForStatus` in the runner, applied to the error code
 * Telegram puts in a 200 body: auth problems and a chat the bot can no longer
 * reach are permanent, a malformed request is a rejection, and 429/5xx are the
 * provider asking us to come back.
 */
const failureForTelegramError = (errorCode: number | undefined, message: string): AlertDeliveryFailure => {
	const fields = {
		message,
		destinationType: "telegram" as const,
		...(errorCode === undefined ? undefined : { providerStatus: errorCode }),
	}
	if (errorCode === 401) return new AlertDeliveryAuthError(fields)
	// 403 is "bot was blocked" / "bot is not a member of the chat" — the chat is
	// unreachable until a human re-adds it, which no retry accomplishes.
	if (errorCode === 403 || errorCode === 404) return new AlertDeliveryTargetMissingError(fields)
	if (errorCode === 400) return new AlertDeliveryRejectedError(fields)
	return new AlertDeliveryError(fields)
}

export const telegramTransport: HttpTransport<Config> = {
	kind: "http",
	type: "telegram",
	peerService: "telegram",
	providerLabel: "Telegram",
	render: (input: RenderInput<Config>) => {
		const { context, templated, linkUrl, chatUrl } = input
		const text = templated
			? buildTelegramTextFromTemplate(templated.title, templated.body, context)
			: buildTelegramText(context)
		return {
			url: `${TELEGRAM_API_ORIGIN}/bot${input.config.botToken}/sendMessage`,
			headers: { "content-type": "application/json" },
			// Fixed vendor host — nothing user-supplied to validate…
			guarded: false,
			// …but the bot token rides in the path, so the span must annotate
			// `server.address` only. The first provider where these two disagree,
			// which is why `sensitivePath` is declared rather than inferred.
			sensitivePath: true,
			body: JSON.stringify({
				chat_id: input.config.chatId,
				text,
				parse_mode: "HTML",
				// The chart as the message's link preview: Telegram renders it inline
				// above the text, so it costs no second `sendPhoto` round-trip. With
				// no chart there is nothing to preview and the links are buttons, so
				// previews stay off rather than unfurling one of them at random.
				link_preview_options: context.chartUrl
					? { url: context.chartUrl, show_above_text: true }
					: { is_disabled: true },
				reply_markup: {
					inline_keyboard: [
						[
							{ text: "Open in Maple", url: linkUrl },
							{ text: "✨ Ask Maple AI", url: chatUrl },
						],
					],
				},
			}),
		}
	},
	interpret: (input, rawBody): Result.Result<ProviderAck, AlertDeliveryFailure> => {
		const parsed = Result.try({
			try: (): unknown => JSON.parse(rawBody),
			catch: () => telegramError("Telegram returned a non-JSON response"),
		})
		if (Result.isFailure(parsed)) return Result.fail(parsed.failure)

		const decoded = decodeTelegramResponse(parsed.success)
		if (Result.isFailure(decoded)) {
			return Result.fail(
				telegramError(`Telegram returned an unexpected response payload: ${decoded.failure.message}`),
			)
		}

		const payload = decoded.success
		if (!payload.ok) {
			const description = payload.description ?? "unknown error"
			return Result.fail(
				failureForTelegramError(
					payload.error_code,
					`Telegram rejected the message: ${truncate(description, 500)}`,
				),
			)
		}
		return Result.succeed({
			providerMessage: `Delivered to Telegram chat ${input.config.chatId}`,
			providerReference: payload.result?.message_id != null ? String(payload.result.message_id) : null,
		})
	},
	// Unreachable: `interpret` always claims the response. Present because the
	// interface requires a success shape for the no-interpret path.
	ack: (input) => ({
		providerMessage: `Delivered to Telegram chat ${input.config.chatId}`,
		providerReference: null,
	}),
}

export type TelegramCredentialVerification =
	| { status: "valid" }
	| { status: "invalid"; reason: string }
	/** Network error / timeout / 429 / 5xx — can't conclude; caller should fail open. */
	| { status: "unknown" }

const telegramApiCall = (
	url: string,
	fetchFn: typeof fetch,
): Effect.Effect<{ ok: boolean; status: number; description: string }> =>
	Effect.tryPromise(() => fetchFn(url, { method: "GET" })).pipe(
		Effect.flatMap((response) =>
			Effect.promise(() => response.text().catch(() => "")).pipe(
				Effect.map((body) => {
					const decoded = decodeTelegramResponse(
						Result.getOrElse(
							Result.try({ try: (): unknown => JSON.parse(body), catch: () => null }),
							() => null,
						),
					)
					const description = Result.getOrElse(
						Result.map(decoded, (payload) => payload.description ?? ""),
						() => "",
					)
					return {
						ok: response.ok,
						status: response.status,
						description: truncate(description.replace(/\s+/g, " ").trim(), 300),
					}
				}),
			),
		),
		Effect.orElseSucceed(() => ({ ok: false, status: 0, description: "" })),
	)

/**
 * Verify a bot token and chat at save time: `getMe` proves the token, `getChat`
 * proves the bot can actually see the chat it was pointed at. The second is the
 * check that matters — a valid token aimed at a group the bot was never added
 * to is by far the most common misconfiguration, and without this it surfaces
 * only when a real alert silently fails to deliver.
 *
 * Never fails: anything ambiguous (transport error, timeout, 429, 5xx) collapses
 * to `unknown` so the caller owns the policy and a Telegram outage cannot block
 * a save. Mirrors `verifyPagerDutyRoutingKey`.
 */
export const verifyTelegramCredentials = (
	botToken: string,
	chatId: string,
	fetchFn: typeof fetch,
	timeoutMs: number,
): Effect.Effect<TelegramCredentialVerification> =>
	Effect.gen(function* () {
		const base = `${TELEGRAM_API_ORIGIN}/bot${botToken}`
		const me = yield* telegramApiCall(`${base}/getMe`, fetchFn)
		if (me.status === 401 || me.status === 404) {
			return { status: "invalid", reason: "Telegram rejected the bot token" } as const
		}
		if (!me.ok) return { status: "unknown" } as const

		const chat = yield* telegramApiCall(`${base}/getChat?chat_id=${encodeURIComponent(chatId)}`, fetchFn)
		if (chat.status === 400 || chat.status === 403 || chat.status === 404) {
			return {
				status: "invalid",
				reason:
					chat.description ||
					"Telegram could not reach that chat — add the bot to it and check the chat ID",
			} as const
		}
		if (!chat.ok) return { status: "unknown" } as const
		return { status: "valid" } as const
	}).pipe(
		Effect.timeoutOrElse({
			duration: Duration.millis(timeoutMs),
			orElse: () => Effect.succeed<TelegramCredentialVerification>({ status: "unknown" }),
		}),
		Effect.orElseSucceed(() => ({ status: "unknown" as const })),
	)

/* -------------------------------------------------------------------------- */
/*  Chat discovery                                                            */
/* -------------------------------------------------------------------------- */

export interface TelegramChat {
	readonly id: string
	readonly title: string
	readonly type: "private" | "group" | "supergroup" | "channel"
}

export type TelegramChatDiscovery =
	| { status: "ok"; chats: ReadonlyArray<TelegramChat> }
	| { status: "invalid"; reason: string }

/**
 * Telegram identifies a chat by a signed integer — negative for groups and
 * channels. Well inside 2^53 (a supergroup id is ~1e12), but it is carried as a
 * string from here on because that is what the destination stores and what the
 * form field holds.
 */
const TelegramChatSchema = Schema.Struct({
	id: Schema.Number,
	type: Schema.String,
	title: Schema.optionalKey(Schema.String),
	username: Schema.optionalKey(Schema.String),
	first_name: Schema.optionalKey(Schema.String),
})

/**
 * The update kinds that can name a chat.
 *
 * `my_chat_member` is the one that makes this feature work at all. Bots join
 * groups with privacy mode ON, so an ordinary message in a group is invisible
 * to `getUpdates` unless it is a command, a mention, or a reply — meaning
 * "send a message and we'll find the chat" fails for exactly the setup people
 * are most likely to have. A `my_chat_member` update fires when the bot is
 * added, promoted, or removed, regardless of privacy mode, so simply adding
 * the bot is enough to surface the chat.
 */
const TelegramUpdateSchema = Schema.Struct({
	message: Schema.optionalKey(Schema.Struct({ chat: TelegramChatSchema })),
	edited_message: Schema.optionalKey(Schema.Struct({ chat: TelegramChatSchema })),
	channel_post: Schema.optionalKey(Schema.Struct({ chat: TelegramChatSchema })),
	my_chat_member: Schema.optionalKey(Schema.Struct({ chat: TelegramChatSchema })),
})

const GetUpdatesResponseSchema = Schema.Struct({
	ok: Schema.optionalKey(Schema.Boolean),
	description: Schema.optionalKey(Schema.String),
	error_code: Schema.optionalKey(Schema.Number),
	result: Schema.optionalKey(Schema.Array(TelegramUpdateSchema)),
})
const decodeGetUpdates = Schema.decodeUnknownResult(GetUpdatesResponseSchema)

const CHAT_TYPES = ["private", "group", "supergroup", "channel"] as const

const chatLabel = (chat: Schema.Schema.Type<typeof TelegramChatSchema>): string =>
	chat.title ?? chat.username ?? chat.first_name ?? `Chat ${chat.id}`

const narrowChatType = (raw: string): TelegramChat["type"] | null =>
	CHAT_TYPES.find((candidate) => candidate === raw) ?? null

/**
 * The chats a bot can currently see, for the destination form's chat picker.
 *
 * Transcribing a negative chat id out of a raw `getUpdates` payload is where
 * this setup fails in practice, so the server does the reading. Two properties
 * this deliberately holds:
 *
 * - **It does not consume updates.** `getUpdates` confirms (and discards)
 *   everything before `offset`, so passing one would delete the bot owner's
 *   pending updates as a side effect of them clicking a button in our UI. With
 *   no offset the call is a read, and it stays repeatable.
 * - **It reports a webhook conflict as its own reason.** A bot with a webhook
 *   registered answers `getUpdates` with 409, which is a fixable state, not a
 *   bad token — saying so is the difference between a 10-second fix and a
 *   confused support ticket.
 *
 * Telegram only retains updates for ~24 hours, so an empty list is a normal
 * answer meaning "nothing recent", not a failure.
 */
export const fetchTelegramChats = (
	botToken: string,
	fetchFn: typeof fetch,
	timeoutMs: number,
): Effect.Effect<TelegramChatDiscovery> =>
	Effect.tryPromise(() =>
		fetchFn(
			`${TELEGRAM_API_ORIGIN}/bot${botToken}/getUpdates?limit=100&timeout=0&allowed_updates=${encodeURIComponent(
				JSON.stringify(["message", "edited_message", "channel_post", "my_chat_member"]),
			)}`,
			{ method: "GET" },
		),
	).pipe(
		Effect.flatMap((response) =>
			Effect.promise(() => response.text().catch(() => "")).pipe(
				Effect.map((raw): TelegramChatDiscovery => {
					const parsed = Result.try({ try: (): unknown => JSON.parse(raw), catch: () => null })
					const decoded = decodeGetUpdates(Result.getOrElse(parsed, () => null))
					if (Result.isFailure(decoded)) {
						return response.ok
							? { status: "invalid", reason: "Telegram returned an unexpected response" }
							: {
									status: "invalid",
									reason: `Telegram rejected the request (${response.status})`,
								}
					}
					const payload = decoded.success
					if (!payload.ok) {
						const description = payload.description ?? ""
						if (payload.error_code === 409 || description.includes("webhook is active")) {
							return {
								status: "invalid",
								reason: "This bot has a webhook registered, so Maple cannot read its recent chats. Delete the webhook (or enter the chat ID by hand).",
							}
						}
						if (payload.error_code === 401) {
							return { status: "invalid", reason: "Telegram rejected the bot token" }
						}
						return {
							status: "invalid",
							reason:
								truncate(description.replace(/\s+/g, " ").trim(), 300) ||
								"Telegram rejected the request",
						}
					}

					const byId = new Map<string, TelegramChat>()
					// Newest first: `getUpdates` returns ascending `update_id`, and the
					// chat someone just added the bot to is the one they are looking for.
					for (const update of [...(payload.result ?? [])].reverse()) {
						const chat = (
							update.my_chat_member ??
							update.message ??
							update.channel_post ??
							update.edited_message
						)?.chat
						if (chat === undefined) continue
						const type = narrowChatType(chat.type)
						if (type === null) continue
						const id = String(chat.id)
						if (!byId.has(id)) byId.set(id, { id, title: chatLabel(chat), type })
					}
					return { status: "ok", chats: [...byId.values()] }
				}),
			),
		),
		Effect.timeoutOrElse({
			duration: Duration.millis(timeoutMs),
			orElse: () =>
				Effect.succeed<TelegramChatDiscovery>({
					status: "invalid",
					reason: "Telegram did not respond in time",
				}),
		}),
		Effect.orElseSucceed(() => ({
			status: "invalid" as const,
			reason: "Could not reach Telegram",
		})),
	)
