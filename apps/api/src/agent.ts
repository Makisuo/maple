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

export interface MapleAgentSetupOptions {
	readonly database?: "d1" | "libsql"
}

const setupCache = new WeakMap<object, Map<string, Promise<MapleAgentSetup>>>()

const buildSetup = async (
	env: Record<string, unknown>,
	options: MapleAgentSetupOptions = {},
): Promise<MapleAgentSetup> => {
	const [appMod, d1DbMod, libsqlDbMod, envMod, registryMod] = await Promise.all([
		import("./app"),
		import("./services/DatabaseD1Live"),
		import("./services/DatabaseLibsqlLive"),
		import("./services/WorkerEnvironment"),
		import("./mcp/tools/registry"),
	])

	const configLive = ConfigProvider.layer(ConfigProvider.fromUnknown(env))
	const workerEnvLive = Layer.succeed(envMod.WorkerEnvironment, env as Record<string, any>)
	const databaseLive =
		options.database === "libsql" ? libsqlDbMod.DatabaseLibsqlLive : d1DbMod.DatabaseD1Live

	const layer = appMod.MainLive.pipe(
		Layer.provideMerge(databaseLive as any),
		Layer.provideMerge(workerEnvLive),
		Layer.provideMerge(configLive),
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
	const key = env as object
	const cacheKey = options.database ?? "d1"
	const envCache = setupCache.get(key) ?? new Map<string, Promise<MapleAgentSetup>>()
	const existing = envCache.get(cacheKey)
	if (existing) return existing
	const built = buildSetup(env, options)
	envCache.set(cacheKey, built)
	setupCache.set(key, envCache)
	return built
}

const decodeOrgId = Schema.decodeUnknownSync(OrgId)

export const resolveOrgOpenrouterKey = async (
	env: Record<string, unknown>,
	orgId: string,
	options: MapleAgentSetupOptions = {},
): Promise<string | undefined> => {
	const { runtime } = await getMapleAgentSetup(env, options)
	const decodedOrgId = decodeOrgId(orgId)
	const result = await runtime.runPromise(
		OrgOpenRouterSettingsService.resolveApiKey(decodedOrgId).pipe(
			Effect.catch(() => Effect.succeed(Option.none<string>())),
		),
	)
	return Option.getOrUndefined(result)
}
