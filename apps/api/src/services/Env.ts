import * as Config from "effect/Config"
import * as Effect from "effect/Effect"

export class Env extends Effect.Service<Env>()("Env", {
  accessors: true,
  effect: Effect.gen(function* () {
    const env = {
      PORT: yield* Config.number("PORT").pipe(Config.withDefault(3472)),
      TINYBIRD_HOST: yield* Config.string("TINYBIRD_HOST"),
      TINYBIRD_TOKEN: yield* Config.redacted("TINYBIRD_TOKEN"),
      MAPLE_DB_URL: yield* Config.string("MAPLE_DB_URL").pipe(Config.withDefault("")),
      MAPLE_DB_AUTH_TOKEN: yield* Config.string("MAPLE_DB_AUTH_TOKEN").pipe(Config.withDefault("")),
      MAPLE_AUTH_MODE: yield* Config.string("MAPLE_AUTH_MODE").pipe(Config.withDefault("self_hosted")),
      MAPLE_ROOT_PASSWORD: yield* Config.string("MAPLE_ROOT_PASSWORD").pipe(Config.withDefault("")),
      MAPLE_DEFAULT_ORG_ID: yield* Config.string("MAPLE_DEFAULT_ORG_ID").pipe(Config.withDefault("default")),
      MAPLE_INGEST_KEY_ENCRYPTION_KEY: yield* Config.string("MAPLE_INGEST_KEY_ENCRYPTION_KEY"),
      MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: yield* Config.string("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY"),
      CLERK_SECRET_KEY: yield* Config.string("CLERK_SECRET_KEY").pipe(Config.withDefault("")),
      CLERK_PUBLISHABLE_KEY: yield* Config.string("CLERK_PUBLISHABLE_KEY").pipe(Config.withDefault("")),
      CLERK_JWT_KEY: yield* Config.string("CLERK_JWT_KEY").pipe(Config.withDefault("")),
      MAPLE_ORG_ID_OVERRIDE: yield* Config.string("MAPLE_ORG_ID_OVERRIDE").pipe(Config.withDefault("")),
      AUTUMN_SECRET_KEY: yield* Config.string("AUTUMN_SECRET_KEY").pipe(Config.withDefault("")),
      SD_INTERNAL_TOKEN: yield* Config.string("SD_INTERNAL_TOKEN").pipe(Config.withDefault("")),
      INTERNAL_SERVICE_TOKEN: yield* Config.string("INTERNAL_SERVICE_TOKEN").pipe(Config.withDefault("")),
    } as const

    if (env.MAPLE_AUTH_MODE.toLowerCase() !== "clerk" && env.MAPLE_ROOT_PASSWORD.trim().length === 0) {
      return yield* Effect.dieMessage("MAPLE_ROOT_PASSWORD is required when MAPLE_AUTH_MODE=self_hosted")
    }

    return env
  }),
}) {}
