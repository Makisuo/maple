import { Clock, Config, Context, Effect, Layer, Option, type PlatformError, Redacted, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import * as os from "node:os"
import * as path from "node:path"

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

const StoredConfigSchema = Schema.Struct({
	apiUrl: Schema.optionalKey(Schema.String),
	token: Schema.optionalKey(Schema.String),
	orgId: Schema.optionalKey(Schema.String),
	defaultMode: Schema.optionalKey(Schema.Literals(["local", "remote"])),
	lastUpdateCheck: Schema.optionalKey(Schema.String),
	latestKnownVersion: Schema.optionalKey(Schema.String),
})
const decodeStoredConfig = Schema.decodeUnknownEffect(StoredConfigSchema)

/** Malformed on-disk config JSON. Caught immediately by `Effect.orElseSucceed`
 *  (a bad/unreadable file falls back to an empty config), but typed so the error
 *  channel isn't a bare `Error`. */
class ConfigParseError extends Schema.TaggedErrorClass<ConfigParseError>()("@maple/cli/ConfigParseError", {
	message: Schema.String,
}) {}

const CONFIG_DIR = path.join(os.homedir(), ".maple")
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json")

const DEFAULT_LOCAL_URL = "http://127.0.0.1:4318"
const DEFAULT_API_URL = "https://api.maple.dev"

const readStored = (fs: FileSystem): Effect.Effect<StoredConfig> =>
	fs.readFileString(CONFIG_PATH).pipe(
		Effect.flatMap((raw) =>
			Effect.try({
				try: () => JSON.parse(raw) as unknown,
				catch: () => new ConfigParseError({ message: "invalid config" }),
			}).pipe(
				Effect.flatMap(decodeStoredConfig),
				Effect.mapError(() => new ConfigParseError({ message: "invalid config" })),
			),
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
	readonly apiUrl: string | undefined
	/** Remote bearer token (env `MAPLE_API_TOKEN` overrides the stored value). */
	readonly token: Option.Option<Redacted.Redacted<string>>
	readonly orgId: string | undefined
	/** Local binary base URL (env `MAPLE_LOCAL_URL`, else the default). */
	readonly localUrl: string
	readonly defaultMode: "local" | "remote" | undefined
	/** API URL to use for `maple login` when none is passed. */
	readonly defaultApiUrl: string
	/** ISO timestamp of the last startup update check (undefined = never checked). */
	readonly lastUpdateCheck: string | undefined
	/** Latest release tag seen by the last update check, or undefined. */
	readonly latestKnownVersion: string | undefined
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
		const envApiUrl = yield* Config.option(Config.string("MAPLE_API_URL"))
		const envToken = yield* Config.option(Config.redacted("MAPLE_API_TOKEN"))
		const envOrgId = yield* Config.option(Config.string("MAPLE_ORG_ID"))
		const envLocalUrl = yield* Config.option(Config.string("MAPLE_LOCAL_URL"))
		const storedToken = Option.map(Option.fromUndefinedOr(stored.token), Redacted.make)
		return {
			apiUrl: Option.getOrElse(envApiUrl, () => stored.apiUrl),
			token: Option.orElse(envToken, () => storedToken),
			orgId: Option.getOrElse(envOrgId, () => stored.orgId),
			localUrl: Option.getOrElse(envLocalUrl, () => DEFAULT_LOCAL_URL),
			defaultMode: stored.defaultMode,
			defaultApiUrl: Option.getOrElse(envApiUrl, () => DEFAULT_API_URL),
			lastUpdateCheck: stored.lastUpdateCheck,
			latestKnownVersion: stored.latestKnownVersion,
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
