import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { Duration, Effect, Layer, Schema, Context } from "effect"
import { Env } from "./Env"

class EmailDeliveryError extends Schema.TaggedErrorClass<EmailDeliveryError>()(
	"@maple/errors/EmailDeliveryError",
	{
		message: Schema.String,
	},
) {}

export interface EmailServiceShape {
	readonly isConfigured: boolean
	readonly send: (
		to: string,
		subject: string,
		html: string,
		replyTo?: string,
	) => Effect.Effect<void, EmailDeliveryError>
}

/**
 * Minimal shape of the Cloudflare Email Service Workers binding (`send_email`).
 * Mirrors the builder overload of `SendEmail` from `@cloudflare/workers-types`
 * — we only use the structured-object form, never the raw MIME `EmailMessage`.
 */
interface SendEmailBinding {
	send: (message: {
		from: string
		to: string
		subject: string
		html?: string
		text?: string
		replyTo?: string
	}) => Promise<{ messageId: string }>
}

const EMAIL_TIMEOUT = Duration.seconds(15)

export class EmailService extends Context.Service<EmailService, EmailServiceShape>()(
	"@maple/api/lib/EmailService",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const fromEmail = env.EMAIL_FROM

			const workerEnv = yield* WorkerEnvironment
			const binding = (workerEnv as Record<string, SendEmailBinding | undefined>).EMAIL

			const isConfigured = binding !== undefined

			const send = Effect.fn("EmailService.send")(function* (
				to: string,
				subject: string,
				html: string,
				replyTo?: string,
			) {
				// PII: never stamp recipient/reply-to addresses on spans or logs
				yield* Effect.annotateCurrentSpan("email.subject", subject)
				yield* Effect.annotateCurrentSpan("email.provider", "cloudflare")

				if (binding === undefined) {
					return yield* Effect.fail(
						new EmailDeliveryError({
							message: "Email not configured: EMAIL binding is missing",
						}),
					)
				}

				const result = yield* Effect.tryPromise({
					try: () =>
						binding.send({
							from: fromEmail,
							to,
							subject,
							html,
							...(replyTo ? { replyTo } : {}),
						}),
					catch: (error) => {
						const code =
							error && typeof error === "object" && "code" in error
								? ` [${String((error as { code: unknown }).code)}]`
								: ""
						return new EmailDeliveryError({
							message:
								error instanceof Error
									? `Cloudflare Email send failed${code}: ${error.message}`
									: "Cloudflare Email send failed",
						})
					},
				}).pipe(
					Effect.timeoutOrElse({
						duration: EMAIL_TIMEOUT,
						orElse: () =>
							Effect.fail(
								new EmailDeliveryError({
									message: "Cloudflare Email send timed out after 15s",
								}),
							),
					}),
				)

				yield* Effect.annotateCurrentSpan("email.message_id", result.messageId)
				yield* Effect.logInfo("Email sent successfully").pipe(
					Effect.annotateLogs({ subject, messageId: result.messageId }),
				)
			})

			return { isConfigured, send } satisfies EmailServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
