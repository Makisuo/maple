/**
 * @since 4.0.0
 */
import * as Layer from "../../Layer.ts"
import * as MessageStorage from "./MessageStorage.ts"
import * as RunnerHealth from "./RunnerHealth.ts"
import * as Runners from "./Runners.ts"
import * as RunnerStorage from "./RunnerStorage.ts"
import * as Sharding from "./Sharding.ts"
import * as ShardingConfig from "./ShardingConfig.ts"

/**
 * An in-memory cluster that can be used for testing purposes.
 *
 * MessageStorage is backed by an in-memory driver, and RunnerStorage is backed
 * by an in-memory driver.
 *
 * @since 4.0.0
 * @category Layers
 */
export const layer: Layer.Layer<
  Sharding.Sharding | Runners.Runners | MessageStorage.MessageStorage | MessageStorage.MemoryDriver
> = Sharding.layer.pipe(
  Layer.provideMerge(Runners.layerNoop),
  Layer.provideMerge(MessageStorage.layerMemory),
  Layer.provide([RunnerStorage.layerMemory, RunnerHealth.layerNoop]),
  Layer.provide(ShardingConfig.layer())
)
