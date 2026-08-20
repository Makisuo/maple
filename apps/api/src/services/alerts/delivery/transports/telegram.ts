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
