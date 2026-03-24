import { autumnHandler } from "autumn-js/backend"
import { Duration, Effect, Layer, Option, Redacted, Schema, ServiceMap } from "effect"
import { Env } from "./Env"

export class AutumnError extends Schema.TaggedErrorClass<AutumnError>()(
  "AutumnError",
  { message: Schema.String },
) {}

export class AutumnService extends ServiceMap.Service<AutumnService>()(
  "AutumnService",
  {
    make: Effect.gen(function* () {
      const env = yield* Env
      const secretKey = Option.match(env.AUTUMN_SECRET_KEY, {
        onNone: () => undefined,
        onSome: (v) => Redacted.value(v),
      })

      const call = Effect.fn("AutumnService.call")(function* (
        routeName: string,
        body: unknown,
        customerId: string,
      ) {
        if (!secretKey) {
          return yield* Effect.fail(
            new AutumnError({ message: "Billing not configured" }),
          )
        }

        const result = yield* Effect.tryPromise({
          try: () =>
            autumnHandler({
              request: { url: `/${routeName}`, method: "POST", body },
              customerId,
              clientOptions: { secretKey },
            }),
          catch: (e) =>
            new AutumnError({
              message:
                e instanceof Error ? e.message : "Autumn request failed",
            }),
        }).pipe(Effect.timeout(Duration.seconds(15)))

        return result
      })

      return { call }
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
}
