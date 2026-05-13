import { ConfigProvider, Effect, Layer, ManagedRuntime, Option, Schema } from "effect"
import { OrgId } from "@maple/domain/http"
import { OrgOpenRouterSettingsService } from "./services/OrgOpenRouterSettingsService"

type MapleAgentRuntime = ManagedRuntime.ManagedRuntime<any, never>

type RegistryModule = typeof import("./mcp/tools/registry")

export interface MapleAgentSetup {
	readonly runtime: MapleAgentRuntime
	readonly mapleToolDefinitions: RegistryModule["mapleToolDefinitions"]
	readonly toInputSchema: (schema: Schema.Top) => Record<string, unknown>
}

/**
 * Which `Database` layer to wire into the agent runtime. The default `d1` is
 * for Cloudflare Worker callers (api, alerting). Node callers (chat-agent)
 * must pass `libsql` because they don't have a D1 binding.
 */
export type MapleAgentDatabase = "d1" | "libsql"

export interface MapleAgentSetupOptions {
	readonly database?: MapleAgentDatabase
}

interface CacheEntry {
	readonly database: MapleAgentDatabase
	readonly promise: Promise<MapleAgentSetup>
}

const setupCache = new WeakMap<object, CacheEntry>()

const buildSetup = async (
	env: Record<string, unknown>,
	database: MapleAgentDatabase,
): Promise<MapleAgentSetup> => {
	const [appMod, envMod, registryMod, dbLayer] = await Promise.all([
		import("./app"),
		import("./services/WorkerEnvironment"),
		import("./mcp/tools/registry"),
		database === "libsql"
			? import("./services/DatabaseLibsqlLive").then((m) => m.DatabaseLibsqlLive)
			: import("./services/DatabaseD1Live").then((m) => m.DatabaseD1Live),
	])

	const configLive = ConfigProvider.layer(ConfigProvider.fromUnknown(env))
	const workerEnvLive = Layer.succeed(envMod.WorkerEnvironment, env as Record<string, any>)

	// Compose the foundation that everything else can depend on. `InfraLive`
	// (= `Env.Default`) consumes ConfigProvider; the libsql `Database` layer
	// reads `MAPLE_DB_URL` from `Env`. Build `baseLive` once, then provide it
	// internally to `dbLayer` and externally to `MainLive`. `provideMerge` on
	// `MainLive` re-exports both `Database` (from db) and `Env` (from base)
	// so tool handlers can resolve them.
	const baseLive = Layer.mergeAll(appMod.InfraLive, workerEnvLive, configLive)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const dbReady = (dbLayer as any).pipe(Layer.provide(baseLive))
	const layer = appMod.MainLive.pipe(
		Layer.provideMerge(dbReady),
		Layer.provideMerge(baseLive),
	)

	return {
		runtime: ManagedRuntime.make(layer as any) as MapleAgentRuntime,
		mapleToolDefinitions: registryMod.mapleToolDefinitions,
		toInputSchema: registryMod.toInputSchema,
	}
}

export const getMapleAgentSetup = (
	env: Record<string, unknown>,
	options: MapleAgentSetupOptions = {},
): Promise<MapleAgentSetup> => {
	const database = options.database ?? "d1"
	const key = env as object
	const existing = setupCache.get(key)
	if (existing && existing.database === database) return existing.promise
	const promise = buildSetup(env, database)
	setupCache.set(key, { database, promise })
	return promise
}

const decodeOrgId = Schema.decodeUnknownSync(OrgId)

export const resolveOrgOpenrouterKey = async (
	env: Record<string, unknown>,
	orgId: string,
): Promise<string | undefined> => {
	const { runtime } = await getMapleAgentSetup(env)
	const decodedOrgId = decodeOrgId(orgId)
	const result = await runtime.runPromise(
		OrgOpenRouterSettingsService.resolveApiKey(decodedOrgId).pipe(
			Effect.catch(() => Effect.succeed(Option.none<string>())),
		),
	)
	return Option.getOrUndefined(result)
}
