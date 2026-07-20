import { Clock, Context, Effect, Layer, Option, Redacted, type PlatformError, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import * as os from "node:os"
import * as path from "node:path"
import { defaultLocalUrl } from "../lib/local-address"

/**
 * On-disk CLI config, stored at `~/.maple/config.json` (mode 0600). The same
 * `~/.maple` directory holds the local binary's data dir and the extracted
 * query CLI, so everything Maple-local lives in one place.
 */
interface StoredConfig {
	apiUrl?: string
	token?: string
	orgId?: string
	defaultMode?: "local" | "remote"
	/** ISO timestamp of the last startup update check (throttles the GitHub probe). */
	lastUpdateCheck?: string
	/** Latest release tag seen by the update check (e.g. "v0.6.0"), cached so the
	 *  notice can render between probes without hitting the network. */
	latestKnownVersion?: string
}

/** Malformed on-disk config JSON. Caught immediately by `Effect.orElseSucceed`
 *  (a bad/unreadable file falls back to an empty config), but typed so the error
 *  channel isn't a bare `Error`. */
class ConfigParseError extends Schema.TaggedErrorClass<ConfigParseError>()("@maple/cli/ConfigParseError", {
	message: Schema.String,
}) {}

const CONFIG_DIR = path.join(os.homedir(), ".maple")
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json")

const DEFAULT_API_URL = "https://api.maple.dev"

const readStored = (fs: FileSystem): Effect.Effect<StoredConfig> =>
	fs.readFileString(CONFIG_PATH).pipe(
		Effect.flatMap((raw) =>
			Effect.try({
				try: (): StoredConfig => {
					const parsed = JSON.parse(raw) as unknown
					return typeof parsed === "object" && parsed !== null ? (parsed as StoredConfig) : {}
				},
				catch: () => new ConfigParseError({ message: "invalid config" }),
			}),
		),
		// Missing/unreadable/invalid file → empty config. The CLI still works in
		// local mode (auto-detect) and `maple login` will create the file.
		Effect.orElseSucceed((): StoredConfig => ({})),
	)

const writeMerged = (
	fs: FileSystem,
	mutate: (cur: StoredConfig) => StoredConfig,
): Effect.Effect<void, PlatformError.PlatformError> =>
	Effect.gen(function* () {
		const merged = mutate(yield* readStored(fs))
		yield* fs.makeDirectory(CONFIG_DIR, { recursive: true })
		yield* fs.writeFileString(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
		// writeFileString's `mode` only applies on create; chmod an existing file
		// too so a token never sits in a world-readable file (best effort).
		yield* fs.chmod(CONFIG_PATH, 0o600).pipe(Effect.ignore)
	})

export interface MapleConfigShape {
	/** Remote API base URL (env `MAPLE_API_URL` overrides the stored value). */
	readonly apiUrl: Option.Option<string>
	/** Remote bearer token (env `MAPLE_API_TOKEN` overrides the stored value). */
	readonly token: Option.Option<Redacted.Redacted<string>>
	readonly orgId: Option.Option<string>
	/** Local binary base URL (env `MAPLE_LOCAL_URL`, else the default). */
	readonly localUrl: string
	readonly defaultMode: Option.Option<"local" | "remote">
	/** API URL to use for `maple login` when none is passed. */
	readonly defaultApiUrl: string
	/** ISO timestamp of the last startup update check (`None` = never checked). */
	readonly lastUpdateCheck: Option.Option<string>
	/** Latest release tag seen by the last update check, or `None`. */
	readonly latestKnownVersion: Option.Option<string>
	/** Persist config fields (merged with existing). */
	readonly write: (next: StoredConfig) => Effect.Effect<void, PlatformError.PlatformError>
	/** Remove the stored token (used by `maple logout`). */
	readonly clearToken: () => Effect.Effect<void, PlatformError.PlatformError>
	/** Pin the default mode (used by `maple use local|remote`). */
	readonly setDefaultMode: (mode: "local" | "remote") => Effect.Effect<void, PlatformError.PlatformError>
	/** Drop the pinned default mode, reverting to auto-detect (`maple use auto`). */
	readonly clearDefaultMode: () => Effect.Effect<void, PlatformError.PlatformError>
	/** Stamp the update-check timestamp (always) and the latest seen tag (when
	 *  provided — omitted on a failed probe so the cached version is preserved). */
	readonly recordUpdateCheck: (latestTag?: string) => Effect.Effect<void, PlatformError.PlatformError>
}

export class MapleConfig extends Context.Service<MapleConfig, MapleConfigShape>()("@maple/cli/MapleConfig", {
	make: Effect.gen(function* () {
		const fs = yield* FileSystem
		const stored = yield* readStored(fs)
		const env = process.env
		return {
			apiUrl: Option.fromNullishOr(env.MAPLE_API_URL ?? stored.apiUrl),
			token: Option.map(Option.fromNullishOr(env.MAPLE_API_TOKEN ?? stored.token), Redacted.make),
			orgId: Option.fromNullishOr(env.MAPLE_ORG_ID ?? stored.orgId),
			localUrl: env.MAPLE_LOCAL_URL ?? defaultLocalUrl(env.MAPLE_LOCAL_BIND_HOST),
			defaultMode: Option.fromNullishOr(stored.defaultMode),
			defaultApiUrl: env.MAPLE_API_URL ?? DEFAULT_API_URL,
			lastUpdateCheck: Option.fromNullishOr(stored.lastUpdateCheck),
			latestKnownVersion: Option.fromNullishOr(stored.latestKnownVersion),
			write: (next) => writeMerged(fs, (cur) => ({ ...cur, ...next })),
			clearToken: () =>
				writeMerged(fs, (cur) => {
					const { token: _token, ...rest } = cur
					return rest
				}),
			setDefaultMode: (mode) => writeMerged(fs, (cur) => ({ ...cur, defaultMode: mode })),
			clearDefaultMode: () =>
				writeMerged(fs, (cur) => {
					const { defaultMode: _mode, ...rest } = cur
					return rest
				}),
			recordUpdateCheck: (latestTag) =>
				Effect.gen(function* () {
					const nowIso = new Date(yield* Clock.currentTimeMillis).toISOString()
					yield* writeMerged(fs, (cur) => ({
						...cur,
						lastUpdateCheck: nowIso,
						...(latestTag ? { latestKnownVersion: latestTag } : {}),
					}))
				}),
		} satisfies MapleConfigShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
