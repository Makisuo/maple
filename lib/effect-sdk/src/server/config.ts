import { Config } from "effect"

/** Resolve the Maple ingest endpoint from environment. */
export const endpoint = Config.option(Config.string("MAPLE_ENDPOINT"))

/** Resolve the Maple ingest key from environment. */
export const ingestKey = Config.option(Config.redacted("MAPLE_INGEST_KEY"))

/**
 * Resolve service version / commit SHA from platform-specific env vars.
 *
 * Priority: COMMIT_SHA > RAILWAY_GIT_COMMIT_SHA > VERCEL_GIT_COMMIT_SHA
 *         > CF_PAGES_COMMIT_SHA > RENDER_GIT_COMMIT
 */
export const serviceVersion = Config.option(
  Config.string("COMMIT_SHA").pipe(
    Config.orElse(() => Config.string("RAILWAY_GIT_COMMIT_SHA")),
    Config.orElse(() => Config.string("VERCEL_GIT_COMMIT_SHA")),
    Config.orElse(() => Config.string("CF_PAGES_COMMIT_SHA")),
    Config.orElse(() => Config.string("RENDER_GIT_COMMIT")),
  ),
)

/**
 * Resolve deployment environment from platform-specific env vars.
 *
 * Priority: MAPLE_ENVIRONMENT > RAILWAY_ENVIRONMENT > VERCEL_ENV > NODE_ENV
 */
export const environment = Config.option(
  Config.string("MAPLE_ENVIRONMENT").pipe(
    Config.orElse(() => Config.string("RAILWAY_ENVIRONMENT")),
    Config.orElse(() => Config.string("VERCEL_ENV")),
    Config.orElse(() => Config.string("NODE_ENV")),
  ),
)
