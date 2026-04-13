import { Context, Effect, Layer, Option, Redacted } from "effect"
import { WorkerBindings, getWorkerBindingString } from "./WorkerBindings"

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

const requireString = (
  bindings: WorkerBindings["Service"],
  key: string,
): Effect.Effect<string, never, never> =>
  Option.match(getWorkerBindingString(bindings, key), {
    onNone: () => Effect.die(new Error(`Missing required env var: ${key}`)),
    onSome: Effect.succeed,
  })

const optionalString = (
  bindings: WorkerBindings["Service"],
  key: string,
): Option.Option<string> => getWorkerBindingString(bindings, key)

const optionalRedacted = (
  bindings: WorkerBindings["Service"],
  key: string,
): Option.Option<Redacted.Redacted<string>> =>
  Option.map(optionalString(bindings, key), Redacted.make)

const stringOrDefault = (
  bindings: WorkerBindings["Service"],
  key: string,
  fallback: string,
): string => Option.getOrElse(optionalString(bindings, key), () => fallback)

const numberOrDefault = (
  bindings: WorkerBindings["Service"],
  key: string,
  fallback: number,
): number => {
  const raw = optionalString(bindings, key)
  if (Option.isNone(raw)) return fallback
  const parsed = Number(raw.value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const makeEnv = Effect.gen(function* () {
  const bindings = yield* WorkerBindings

  const env: EnvShape = {
    PORT: numberOrDefault(bindings, "PORT", 3472),
    TINYBIRD_HOST: yield* requireString(bindings, "TINYBIRD_HOST"),
    TINYBIRD_TOKEN: Redacted.make(yield* requireString(bindings, "TINYBIRD_TOKEN")),
    MAPLE_DB_URL: stringOrDefault(bindings, "MAPLE_DB_URL", ""),
    MAPLE_DB_AUTH_TOKEN: optionalRedacted(bindings, "MAPLE_DB_AUTH_TOKEN"),
    MAPLE_AUTH_MODE: stringOrDefault(bindings, "MAPLE_AUTH_MODE", "self_hosted"),
    MAPLE_ROOT_PASSWORD: optionalRedacted(bindings, "MAPLE_ROOT_PASSWORD"),
    MAPLE_DEFAULT_ORG_ID: stringOrDefault(bindings, "MAPLE_DEFAULT_ORG_ID", "default"),
    MAPLE_INGEST_KEY_ENCRYPTION_KEY: Redacted.make(
      yield* requireString(bindings, "MAPLE_INGEST_KEY_ENCRYPTION_KEY"),
    ),
    MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: Redacted.make(
      yield* requireString(bindings, "MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY"),
    ),
    MAPLE_INGEST_PUBLIC_URL: stringOrDefault(
      bindings,
      "MAPLE_INGEST_PUBLIC_URL",
      "http://127.0.0.1:3474",
    ),
    MAPLE_APP_BASE_URL: stringOrDefault(
      bindings,
      "MAPLE_APP_BASE_URL",
      "http://127.0.0.1:3471",
    ),
    CLERK_SECRET_KEY: optionalRedacted(bindings, "CLERK_SECRET_KEY"),
    CLERK_PUBLISHABLE_KEY: optionalString(bindings, "CLERK_PUBLISHABLE_KEY"),
    CLERK_JWT_KEY: optionalRedacted(bindings, "CLERK_JWT_KEY"),
    MAPLE_ORG_ID_OVERRIDE: optionalString(bindings, "MAPLE_ORG_ID_OVERRIDE"),
    AUTUMN_SECRET_KEY: optionalRedacted(bindings, "AUTUMN_SECRET_KEY"),
    SD_INTERNAL_TOKEN: optionalRedacted(bindings, "SD_INTERNAL_TOKEN"),
    INTERNAL_SERVICE_TOKEN: optionalRedacted(bindings, "INTERNAL_SERVICE_TOKEN"),
    RESEND_API_KEY: optionalRedacted(bindings, "RESEND_API_KEY"),
    RESEND_FROM_EMAIL: stringOrDefault(
      bindings,
      "RESEND_FROM_EMAIL",
      "Maple <notifications@maple.dev>",
    ),
  }

  if (env.MAPLE_DEFAULT_ORG_ID.trim().length === 0) {
    return yield* Effect.die(new Error("MAPLE_DEFAULT_ORG_ID cannot be empty"))
  }

  const authMode = env.MAPLE_AUTH_MODE.toLowerCase()

  if (authMode !== "clerk" && Option.isNone(env.MAPLE_ROOT_PASSWORD)) {
    return yield* Effect.die(
      new Error("MAPLE_ROOT_PASSWORD is required when MAPLE_AUTH_MODE=self_hosted"),
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
