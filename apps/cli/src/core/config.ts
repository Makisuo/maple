import { Clock, Context, Effect, Layer, Option, Redacted, type PlatformError, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import * as os from "node:os"
import * as path from "node:path"
import { defaultLocalUrl } from "../lib/local-address"
import { deleteNativeCredential, readNativeCredential, writeNativeCredential } from "./credential-store"

/**
 * On-disk CLI config, stored at `~/.maple/config.json` (mode 0600). The same
 * `~/.maple` directory holds the local binary's data dir and the extracted
 * query CLI, so everything Maple-local lives in one place.
 */
interface StoredConfig {
	apiUrl?: string
	token?: string
	orgId?: string
	userId?: string
	credentialStore?: "keychain" | "file"
	credentialManaged?: boolean
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
	readonly userId: Option.Option<string>
	readonly credentialStore: Option.Option<"keychain" | "file">
	readonly credentialManaged: boolean
	readonly tokenSource: "env" | "keychain" | "file" | "none"
	readonly envTokenOverride: boolean
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
	readonly saveRemoteCredential: (next: {
		readonly apiUrl: string
		readonly token: string
		readonly orgId: string
		readonly userId: string
		readonly managed: boolean
	}) => Effect.Effect<"keychain" | "file", PlatformError.PlatformError>
	readonly clearRemoteCredential: () => Effect.Effect<void, PlatformError.PlatformError>
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
		const resolvedApiUrl = env.MAPLE_API_URL ?? stored.apiUrl
		const envToken = env.MAPLE_API_TOKEN
		const nativeToken =
			!envToken && !stored.token && stored.credentialStore === "keychain" && resolvedApiUrl
				? yield* Effect.promise(() => readNativeCredential(resolvedApiUrl))
				: undefined
		const resolvedToken = envToken ?? stored.token ?? nativeToken
		const tokenSource = envToken
			? ("env" as const)
			: stored.token
				? ("file" as const)
				: nativeToken
					? ("keychain" as const)
					: ("none" as const)
		return {
			apiUrl: Option.fromNullishOr(resolvedApiUrl),
			token: Option.map(Option.fromNullishOr(resolvedToken), Redacted.make),
			orgId: Option.fromNullishOr(env.MAPLE_ORG_ID ?? stored.orgId),
			userId: Option.fromNullishOr(stored.userId),
			credentialStore: Option.fromNullishOr(stored.credentialStore),
			credentialManaged: stored.credentialManaged === true,
			tokenSource,
			envTokenOverride: envToken !== undefined,
			localUrl: env.MAPLE_LOCAL_URL ?? defaultLocalUrl(env.MAPLE_LOCAL_BIND_HOST),
			defaultMode: Option.fromNullishOr(stored.defaultMode),
			defaultApiUrl: env.MAPLE_API_URL ?? DEFAULT_API_URL,
			lastUpdateCheck: Option.fromNullishOr(stored.lastUpdateCheck),
			latestKnownVersion: Option.fromNullishOr(stored.latestKnownVersion),
			write: (next) => writeMerged(fs, (cur) => ({ ...cur, ...next })),
			saveRemoteCredential: (next) =>
				Effect.gen(function* () {
					const storedInKeychain = yield* Effect.promise(() =>
						writeNativeCredential(next.apiUrl, next.token),
					)
					if (!storedInKeychain) {
						yield* Effect.promise(() => deleteNativeCredential(next.apiUrl))
					}
					yield* writeMerged(fs, (cur) => {
						const { token: _token, ...withoutToken } = cur
						return {
							...withoutToken,
							apiUrl: next.apiUrl,
							orgId: next.orgId,
							userId: next.userId,
							credentialManaged: next.managed,
							credentialStore: storedInKeychain ? "keychain" : "file",
							...(storedInKeychain ? {} : { token: next.token }),
						}
					})
					return storedInKeychain ? "keychain" : "file"
				}),
			clearRemoteCredential: () =>
				Effect.gen(function* () {
					const storedApiUrl = stored.apiUrl
					if (storedApiUrl && stored.credentialStore === "keychain") {
						yield* Effect.promise(() => deleteNativeCredential(storedApiUrl))
					}
					yield* writeMerged(fs, (cur) => {
						const {
							token: _token,
							apiUrl: _apiUrl,
							orgId: _orgId,
							userId: _userId,
							credentialStore: _store,
							credentialManaged: _managed,
							...rest
						} = cur
						return rest
					})
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
