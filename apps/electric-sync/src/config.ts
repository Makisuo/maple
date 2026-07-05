import type { AuthEnv } from "@maple/auth"
import {
	optionalRedacted,
	optionalString,
	stringWithDefault,
} from "@maple/effect-cloudflare/config-helpers"
import { Config, Context, Effect, Layer, Option, Redacted } from "effect"

/**
 * Standalone config for the Electric shape-sync worker. Deliberately a small,
 * self-contained subset — NOT the full `@maple/api` `Env` — so this worker never
 * has to supply `TINYBIRD_*` / `MAPLE_INGEST_KEY_*` etc. it doesn't use. It reads
 * exactly two concerns:
 *
 *  - the Electric upstream (`ELECTRIC_*`), and
 *  - the auth fields (`AuthEnv`) consumed by `makeResolveTenant`.
 *
 * `SyncConfigShape extends AuthEnv`, so the value can be handed straight to
 * `makeResolveTenant` (see routes/shape.http.ts).
 */
export interface SyncConfigShape extends AuthEnv {
	readonly ELECTRIC_URL: Option.Option<string>
	readonly ELECTRIC_SOURCE_ID: Option.Option<string>
	readonly ELECTRIC_SECRET: Option.Option<Redacted.Redacted<string>>
}

const syncConfig = Config.all({
	// Electric upstream: base URL of the Electric HTTP API (docker `electric`
	// locally, Electric Cloud in prod) + optional Cloud source credentials. Absent
	// ELECTRIC_URL disables sync (the proxy 503s).
	ELECTRIC_URL: optionalString("ELECTRIC_URL"),
	ELECTRIC_SOURCE_ID: optionalString("ELECTRIC_SOURCE_ID"),
	ELECTRIC_SECRET: optionalRedacted("ELECTRIC_SECRET"),
	// Auth (mirrors the AuthEnv subset of @maple/api's Env — same defaults).
	MAPLE_AUTH_MODE: stringWithDefault("MAPLE_AUTH_MODE", "self_hosted"),
	MAPLE_DEFAULT_ORG_ID: stringWithDefault("MAPLE_DEFAULT_ORG_ID", "default"),
	MAPLE_ORG_ID_OVERRIDE: optionalString("MAPLE_ORG_ID_OVERRIDE"),
	MAPLE_ROOT_PASSWORD: optionalRedacted("MAPLE_ROOT_PASSWORD"),
	CLERK_SECRET_KEY: optionalRedacted("CLERK_SECRET_KEY"),
	CLERK_PUBLISHABLE_KEY: optionalString("CLERK_PUBLISHABLE_KEY"),
	CLERK_JWT_KEY: optionalRedacted("CLERK_JWT_KEY"),
})

// Fail fast at layer build on the same fatal misconfigurations `@maple/api`'s
// Env catches — a missing self-hosted password or Clerk secret would otherwise
// surface as a per-request defect instead of a startup error.
const makeSyncConfig = Effect.gen(function* () {
	const config: SyncConfigShape = yield* syncConfig
	const authMode = config.MAPLE_AUTH_MODE.toLowerCase()

	if (config.MAPLE_DEFAULT_ORG_ID.trim().length === 0) {
		return yield* Effect.die(new Error("MAPLE_DEFAULT_ORG_ID cannot be empty"))
	}

	if (authMode !== "clerk" && Option.isNone(config.MAPLE_ROOT_PASSWORD)) {
		return yield* Effect.die(
			new Error("MAPLE_ROOT_PASSWORD is required when MAPLE_AUTH_MODE=self_hosted"),
		)
	}

	if (authMode === "clerk" && Option.isNone(config.CLERK_SECRET_KEY)) {
		return yield* Effect.die(new Error("CLERK_SECRET_KEY is required when MAPLE_AUTH_MODE=clerk"))
	}

	return SyncConfig.of(config)
})

export class SyncConfig extends Context.Service<SyncConfig, SyncConfigShape>()(
	"@maple/electric-sync/SyncConfig",
) {
	static readonly layer = Layer.effect(this, makeSyncConfig)
}
