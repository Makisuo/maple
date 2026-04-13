import { Config, Context, Effect, Layer, Option, Redacted } from "effect"

export interface EnvShape {
  readonly PORT: number
  readonly TINYBIRD_HOST: string
  readonly TINYBIRD_TOKEN: Redacted.Redacted<string>
  readonly MAPLE_DB_URL: string
  readonly MAPLE_DB_AUTH_TOKEN: Option.Option<Redacted.Redacted<string>>
  readonly MAPLE_AUTH_MODE: string
  readonly MAPLE_ROOT_PASSWORD: Option.Option<Redacted.Redacted<string>>
  readonly MAPLE_DEFAULT_ORG_ID: string
  readonly MAPLE_INGEST_KEY_ENCRYPTION_KEY: Redacted.Redacted<string>
  readonly MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: Redacted.Redacted<string>
  readonly MAPLE_INGEST_PUBLIC_URL: string
  readonly MAPLE_APP_BASE_URL: string
  readonly CLERK_SECRET_KEY: Option.Option<Redacted.Redacted<string>>
  readonly CLERK_PUBLISHABLE_KEY: Option.Option<string>
  readonly CLERK_JWT_KEY: Option.Option<Redacted.Redacted<string>>
  readonly MAPLE_ORG_ID_OVERRIDE: Option.Option<string>
  readonly AUTUMN_SECRET_KEY: Option.Option<Redacted.Redacted<string>>
  readonly SD_INTERNAL_TOKEN: Option.Option<Redacted.Redacted<string>>
  readonly INTERNAL_SERVICE_TOKEN: Option.Option<Redacted.Redacted<string>>
  readonly RESEND_API_KEY: Option.Option<Redacted.Redacted<string>>
  readonly RESEND_FROM_EMAIL: string
}

const stringWithDefault = (key: string, fallback: string) =>
  Config.string(key).pipe(Config.withDefault(fallback))

const optionalString = (key: string) =>
  Config.option(Config.string(key)).pipe(
    Config.map((opt) =>
      Option.flatMap(opt, (s) =>
        s.trim().length > 0 ? Option.some(s) : Option.none(),
      ),
    ),
  )

const optionalRedacted = (key: string) =>
  Config.option(Config.string(key)).pipe(
    Config.map((opt) =>
      Option.flatMap(opt, (s) =>
        s.trim().length > 0 ? Option.some(Redacted.make(s)) : Option.none(),
      ),
    ),
  )

const portConfig = Config.number("PORT").pipe(Config.withDefault(3472))

const envConfig = Config.all({
  PORT: portConfig,
  TINYBIRD_HOST: Config.string("TINYBIRD_HOST"),
  TINYBIRD_TOKEN: Config.redacted("TINYBIRD_TOKEN"),
  MAPLE_DB_URL: stringWithDefault("MAPLE_DB_URL", ""),
  MAPLE_DB_AUTH_TOKEN: optionalRedacted("MAPLE_DB_AUTH_TOKEN"),
  MAPLE_AUTH_MODE: stringWithDefault("MAPLE_AUTH_MODE", "self_hosted"),
  MAPLE_ROOT_PASSWORD: optionalRedacted("MAPLE_ROOT_PASSWORD"),
  MAPLE_DEFAULT_ORG_ID: stringWithDefault("MAPLE_DEFAULT_ORG_ID", "default"),
  MAPLE_INGEST_KEY_ENCRYPTION_KEY: Config.redacted(
    "MAPLE_INGEST_KEY_ENCRYPTION_KEY",
  ),
  MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: Config.redacted(
    "MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY",
  ),
  MAPLE_INGEST_PUBLIC_URL: stringWithDefault(
    "MAPLE_INGEST_PUBLIC_URL",
    "http://127.0.0.1:3474",
  ),
  MAPLE_APP_BASE_URL: stringWithDefault(
    "MAPLE_APP_BASE_URL",
    "http://127.0.0.1:3471",
  ),
  CLERK_SECRET_KEY: optionalRedacted("CLERK_SECRET_KEY"),
  CLERK_PUBLISHABLE_KEY: optionalString("CLERK_PUBLISHABLE_KEY"),
  CLERK_JWT_KEY: optionalRedacted("CLERK_JWT_KEY"),
  MAPLE_ORG_ID_OVERRIDE: optionalString("MAPLE_ORG_ID_OVERRIDE"),
  AUTUMN_SECRET_KEY: optionalRedacted("AUTUMN_SECRET_KEY"),
  SD_INTERNAL_TOKEN: optionalRedacted("SD_INTERNAL_TOKEN"),
  INTERNAL_SERVICE_TOKEN: optionalRedacted("INTERNAL_SERVICE_TOKEN"),
  RESEND_API_KEY: optionalRedacted("RESEND_API_KEY"),
  RESEND_FROM_EMAIL: stringWithDefault(
    "RESEND_FROM_EMAIL",
    "Maple <notifications@maple.dev>",
  ),
})

const makeEnv = Effect.gen(function* () {
  const env = (yield* envConfig) as EnvShape

  if (env.MAPLE_DEFAULT_ORG_ID.trim().length === 0) {
    return yield* Effect.die(new Error("MAPLE_DEFAULT_ORG_ID cannot be empty"))
  }

  const authMode = env.MAPLE_AUTH_MODE.toLowerCase()

  if (authMode !== "clerk" && Option.isNone(env.MAPLE_ROOT_PASSWORD)) {
    return yield* Effect.die(
      new Error(
        "MAPLE_ROOT_PASSWORD is required when MAPLE_AUTH_MODE=self_hosted",
      ),
    )
  }

  if (authMode === "clerk" && Option.isNone(env.CLERK_SECRET_KEY)) {
    return yield* Effect.die(
      new Error("CLERK_SECRET_KEY is required when MAPLE_AUTH_MODE=clerk"),
    )
  }

  if (
    Option.isSome(env.MAPLE_ROOT_PASSWORD) &&
    Redacted.value(env.MAPLE_ROOT_PASSWORD.value).trim().length === 0
  ) {
    return yield* Effect.die(new Error("MAPLE_ROOT_PASSWORD cannot be empty"))
  }

  return env
})

export class Env extends Context.Service<Env, EnvShape>()("Env") {
  static readonly Default = Layer.effect(this, makeEnv)
}
