/**
 * @since 4.0.0
 */
import * as Layer from "effect/Layer"
import type { ConfigError } from "../../Config.ts"
import type * as SqlClient from "../sql/SqlClient.ts"
import type * as MessageStorage from "./MessageStorage.ts"
import * as RunnerHealth from "./RunnerHealth.ts"
import * as Runners from "./Runners.ts"
import * as RunnerStorage from "./RunnerStorage.ts"
import * as Sharding from "./Sharding.ts"
import * as ShardingConfig from "./ShardingConfig.ts"
import * as SqlMessageStorage from "./SqlMessageStorage.ts"
import * as SqlRunnerStorage from "./SqlRunnerStorage.ts"

/**
 * A sql backed single-node cluster, that can be used for running durable
 * entities and workflows.
 *
 * @since 4.0.0
 * @category Layers
 */
export const layer = (options?: {
  readonly shardingConfig?: Partial<ShardingConfig.ShardingConfig["Service"]> | undefined
  readonly runnerStorage?: "memory" | "sql" | undefined
}): Layer.Layer<
  | Sharding.Sharding
  | Runners.Runners
  | MessageStorage.MessageStorage,
  ConfigError,
  SqlClient.SqlClient
> =>
  Sharding.layer.pipe(
    Layer.provideMerge(Runners.layerNoop),
    Layer.provideMerge(SqlMessageStorage.layer),
    Layer.provide([
      options?.runnerStorage === "memory" ? RunnerStorage.layerMemory : Layer.orDie(SqlRunnerStorage.layer),
      RunnerHealth.layerNoop
    ]),
    Layer.provide(ShardingConfig.layerFromEnv(options?.shardingConfig))
  )
