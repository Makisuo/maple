import { Duration, Effect, Layer, Option, Redacted, Schema, ServiceMap } from "effect"
import { Env } from "./Env"

export class EmailDeliveryError extends Schema.TaggedErrorClass<EmailDeliveryError>()(
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
  ) => Effect.Effect<void, EmailDeliveryError>
}

const EMAIL_TIMEOUT = Duration.seconds(15)

export class EmailService extends ServiceMap.Service<EmailService, EmailServiceShape>()(
  "EmailService",
  {
    make: Effect.gen(function* () {
      const env = yield* Env
      const apiKey = env.RESEND_API_KEY
      const fromEmail = env.RESEND_FROM_EMAIL

      const isConfigured = Option.isSome(apiKey)

      const send = Effect.fn("EmailService.send")(function* (
        to: string,
        subject: string,
        html: string,
      ) {
        yield* Effect.annotateCurrentSpan("email.to", to)
        yield* Effect.annotateCurrentSpan("email.subject", subject)
        yield* Effect.annotateCurrentSpan("email.provider", "resend")

        if (Option.isNone(apiKey)) {
          return yield* Effect.fail(
            new EmailDeliveryError({
              message: "Email not configured: RESEND_API_KEY is not set",
            }),
          )
        }

        const response = yield* Effect.tryPromise({
          try: () =>
            fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${Redacted.value(apiKey.value)}`,
              },
              body: JSON.stringify({
                from: fromEmail,
                to: [to],
                subject,
                html,
              }),
            }),
          catch: (error) =>
            new EmailDeliveryError({
              message: error instanceof Error
                ? error.message
                : "Resend API request failed",
            }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: EMAIL_TIMEOUT,
            onTimeout: () =>
              Effect.fail(
                new EmailDeliveryError({
                  message: "Resend API request timed out after 15s",
                }),
              ),
          }),
        )

        yield* Effect.annotateCurrentSpan("http.status_code", response.status)

        if (!response.ok) {
          const body = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: () =>
              new EmailDeliveryError({
                message: `Resend API returned ${response.status}`,
              }),
          })
          yield* Effect.logError("Email delivery failed").pipe(
            Effect.annotateLogs({ to, subject, status: response.status, body }),
          )
          return yield* Effect.fail(
            new EmailDeliveryError({
              message: `Resend API returned ${response.status}: ${body}`,
            }),
          )
        }

        yield* Effect.logInfo("Email sent successfully").pipe(
          Effect.annotateLogs({ to, subject }),
        )
      })

      return { isConfigured, send }
    }),
  },
) {
  static readonly Default = Layer.effect(this, this.make)
}
