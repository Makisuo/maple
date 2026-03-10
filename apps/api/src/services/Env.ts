import * as Config from "effect/Config";
import { Effect, Option, Redacted } from "effect";

export class Env extends Effect.Service<Env>()("Env", {
  accessors: true,
  effect: Effect.gen(function* () {
    const normalizeOptionalString = (value: Option.Option<string>) =>
      Option.filter(value, (entry) => entry.trim().length > 0)

    const normalizeOptionalSecret = (
      value: Option.Option<Redacted.Redacted<string>>,
    ) =>
      Option.filter(value, (entry) => Redacted.value(entry).trim().length > 0)

    const env = {
      PORT: yield* Config.number("PORT").pipe(Config.withDefault(3472)),
      TINYBIRD_HOST: yield* Config.string("TINYBIRD_HOST"),
      TINYBIRD_TOKEN: yield* Config.redacted("TINYBIRD_TOKEN"),
      MAPLE_DB_URL: yield* Config.string("MAPLE_DB_URL").pipe(
        Config.withDefault(""),
      ),
      MAPLE_DB_AUTH_TOKEN: yield* Config.option(
        Config.redacted("MAPLE_DB_AUTH_TOKEN"),
      ),
      MAPLE_AUTH_MODE: yield* Config.string("MAPLE_AUTH_MODE").pipe(
        Config.withDefault("self_hosted"),
      ),
      MAPLE_ROOT_PASSWORD: yield* Config.option(
        Config.redacted("MAPLE_ROOT_PASSWORD"),
      ),
      MAPLE_DEFAULT_ORG_ID: yield* Config.string("MAPLE_DEFAULT_ORG_ID").pipe(
        Config.withDefault("default"),
      ),
      MAPLE_INGEST_KEY_ENCRYPTION_KEY: yield* Config.redacted(
        "MAPLE_INGEST_KEY_ENCRYPTION_KEY",
      ),
      MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: yield* Config.redacted(
        "MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY",
      ),
      MAPLE_INGEST_PUBLIC_URL: yield* Config.string(
        "MAPLE_INGEST_PUBLIC_URL",
      ).pipe(Config.withDefault("http://127.0.0.1:3474")),
      CLERK_SECRET_KEY: yield* Config.option(Config.redacted("CLERK_SECRET_KEY")),
      CLERK_PUBLISHABLE_KEY: yield* Config.option(
        Config.string("CLERK_PUBLISHABLE_KEY"),
      ),
      CLERK_JWT_KEY: yield* Config.option(Config.redacted("CLERK_JWT_KEY")),
      MAPLE_ORG_ID_OVERRIDE: yield* Config.option(
        Config.string("MAPLE_ORG_ID_OVERRIDE"),
      ),
      AUTUMN_SECRET_KEY: yield* Config.option(Config.redacted("AUTUMN_SECRET_KEY")),
      SD_INTERNAL_TOKEN: yield* Config.option(Config.redacted("SD_INTERNAL_TOKEN")),
      INTERNAL_SERVICE_TOKEN: yield* Config.option(
        Config.redacted("INTERNAL_SERVICE_TOKEN"),
      ),
    } as const;

    const normalizedEnv = {
      ...env,
      MAPLE_DB_AUTH_TOKEN: normalizeOptionalSecret(env.MAPLE_DB_AUTH_TOKEN),
      MAPLE_ROOT_PASSWORD: normalizeOptionalSecret(env.MAPLE_ROOT_PASSWORD),
      CLERK_SECRET_KEY: normalizeOptionalSecret(env.CLERK_SECRET_KEY),
      CLERK_PUBLISHABLE_KEY: normalizeOptionalString(env.CLERK_PUBLISHABLE_KEY),
      CLERK_JWT_KEY: normalizeOptionalSecret(env.CLERK_JWT_KEY),
      MAPLE_ORG_ID_OVERRIDE: normalizeOptionalString(env.MAPLE_ORG_ID_OVERRIDE),
      AUTUMN_SECRET_KEY: normalizeOptionalSecret(env.AUTUMN_SECRET_KEY),
      SD_INTERNAL_TOKEN: normalizeOptionalSecret(env.SD_INTERNAL_TOKEN),
      INTERNAL_SERVICE_TOKEN: normalizeOptionalSecret(env.INTERNAL_SERVICE_TOKEN),
    } as const

    const authMode = normalizedEnv.MAPLE_AUTH_MODE.toLowerCase()

    if (
      normalizedEnv.MAPLE_DEFAULT_ORG_ID.trim().length === 0
    ) {
      return yield* Effect.dieMessage("MAPLE_DEFAULT_ORG_ID cannot be empty")
    }

    if (authMode !== "clerk" && Option.isNone(normalizedEnv.MAPLE_ROOT_PASSWORD)) {
      return yield* Effect.dieMessage(
        "MAPLE_ROOT_PASSWORD is required when MAPLE_AUTH_MODE=self_hosted",
      );
    }

    if (authMode === "clerk") {
      if (Option.isNone(normalizedEnv.CLERK_SECRET_KEY)) {
        return yield* Effect.dieMessage(
          "CLERK_SECRET_KEY is required when MAPLE_AUTH_MODE=clerk",
        )
      }

    }

    if (
      Option.isSome(normalizedEnv.MAPLE_ROOT_PASSWORD) &&
      Redacted.value(normalizedEnv.MAPLE_ROOT_PASSWORD.value).trim().length === 0
    ) {
      return yield* Effect.dieMessage("MAPLE_ROOT_PASSWORD cannot be empty")
    }

    return normalizedEnv;
  }),
}) {}
