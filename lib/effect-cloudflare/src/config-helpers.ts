// Small effect `Config` helpers shared by worker env schemas (apps/api's `Env`,
// apps/electric-sync's `SyncConfig`). Kept in a standalone module — NOT the
// package index — because the index barrel statically imports `cloudflare:workers`,
// which would break non-Worker/test consumers (e.g. apps/api's Env, imported by
// vitest). This module imports only `effect`, so it's safe everywhere.
import { Config, Option, Redacted } from "effect"

/** `Config.string(key)` with a fallback when the env var is unset. */
export const stringWithDefault = (key: string, fallback: string) =>
	Config.string(key).pipe(Config.withDefault(fallback))

/** Optional string; treats a blank/whitespace-only value as absent (`None`). */
export const optionalString = (key: string) =>
	Config.option(Config.string(key)).pipe(
		Config.map((opt) =>
			Option.flatMap(opt, (s) => (s.trim().length > 0 ? Option.some(s) : Option.none())),
		),
	)

/** Optional redacted secret; treats a blank/whitespace-only value as absent (`None`). */
export const optionalRedacted = (key: string) =>
	Config.option(Config.string(key)).pipe(
		Config.map((opt) =>
			Option.flatMap(opt, (s) => (s.trim().length > 0 ? Option.some(Redacted.make(s)) : Option.none())),
		),
	)
