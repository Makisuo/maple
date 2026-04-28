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

const setupCache = new WeakMap<object, Promise<MapleAgentSetup>>()

const buildSetup = async (env: Record<string, unknown>): Promise<MapleAgentSetup> => {
	const [appMod, dbMod, envMod, registryMod] = await Promise.all([
		import("./app"),
		import("./services/DatabaseD1Live"),
		import("./services/WorkerEnvironment"),
		import("./mcp/tools/registry"),
	])

	const configLive = ConfigProvider.layer(ConfigProvider.fromUnknown(env))
	const workerEnvLive = Layer.succeed(envMod.WorkerEnvironment, env as Record<string, any>)

	const layer = appMod.MainLive.pipe(
		Layer.provideMerge(dbMod.DatabaseD1Live),
		Layer.provideMerge(workerEnvLive),
		Layer.provideMerge(configLive),
	)

	return {
		runtime: ManagedRuntime.make(layer as any) as MapleAgentRuntime,
		mapleToolDefinitions: registryMod.mapleToolDefinitions,
		toInputSchema: registryMod.toInputSchema,
	}
}

export const getMapleAgentSetup = (env: Record<string, unknown>): Promise<MapleAgentSetup> => {
	const key = env as object
	const existing = setupCache.get(key)
	if (existing) return existing
	const built = buildSetup(env)
	setupCache.set(key, built)
	return built
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
