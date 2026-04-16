import { ConfigProvider, Layer, ManagedRuntime } from "effect"
import { MainLive } from "./app"
import { mapleToolDefinitions, toInputSchema } from "./mcp/tools/registry"
import { DatabaseD1Live } from "./services/DatabaseD1Live"
import { WorkerEnvironment } from "./services/WorkerEnvironment"

const buildMapleAgentLayer = (env: Record<string, unknown>) => {
  const configLive = ConfigProvider.layer(ConfigProvider.fromUnknown(env))
  const workerEnvLive = Layer.succeed(
    WorkerEnvironment,
    env as Record<string, any>,
  )

  return Layer.mergeAll(MainLive, DatabaseD1Live).pipe(
    Layer.provideMerge(workerEnvLive),
    Layer.provideMerge(configLive),
  )
}

type MapleAgentRuntime = ManagedRuntime.ManagedRuntime<any, never>

const runtimeCache = new WeakMap<object, MapleAgentRuntime>()

export const getMapleAgentRuntime = (
  env: Record<string, unknown>,
): MapleAgentRuntime => {
  const key = env as object
  const existing = runtimeCache.get(key)
  if (existing) return existing
  const built = ManagedRuntime.make(buildMapleAgentLayer(env) as any) as MapleAgentRuntime
  runtimeCache.set(key, built)
  return built
}

export { mapleToolDefinitions, toInputSchema }
