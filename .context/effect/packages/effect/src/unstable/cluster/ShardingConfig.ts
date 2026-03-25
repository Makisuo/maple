/**
 * @since 4.0.0
 */
import * as Config from "../../Config.ts"
import * as ConfigProvider from "../../ConfigProvider.ts"
import * as Duration from "../../Duration.ts"
import * as Effect from "../../Effect.ts"
import * as Layer from "../../Layer.ts"
import * as Option from "../../Option.ts"
import * as Schema from "../../Schema.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import { RunnerAddress } from "./RunnerAddress.ts"

/**
 * Represents the configuration for the `Sharding` service on a given runner.
 *
 * @since 4.0.0
 * @category models
 */
export class ShardingConfig extends ServiceMap.Service<ShardingConfig, {
  /**
   * The address for the current runner that other runners can use to
   * communicate with it.
   *
   * If `None`, the runner is not part of the cluster and will be in a client-only
   * mode.
   */
  readonly runnerAddress: Option.Option<RunnerAddress>
  /**
   * The listen address for the current runner.
   *
   * Defaults to the `runnerAddress`.
   */
  readonly runnerListenAddress: Option.Option<RunnerAddress>
  /**
   * A number that determines how many shards this runner will be assigned
   * relative to other runners.
   *
   * Defaults to `1`.
   *
   * A value of `2` means that this runner should be assigned twice as many
   * shards as a runner with a weight of `1`.
   */
  readonly runnerShardWeight: number
  /**
   * The shard groups that are assigned to this runner.
   *
   * Defaults to `["default"]`.
   */
  readonly shardGroups: ReadonlyArray<string>
  /**
   * The number of shards to allocate per shard group.
   *
   * **Note**: this value should be consistent across all runners.
   */
  readonly shardsPerGroup: number
  /**
   * Shard lock refresh interval.
   */
  readonly shardLockRefreshInterval: Duration.Input
  /**
   * Shard lock expiration duration.
   */
  readonly shardLockExpiration: Duration.Input
  /**
   * Disable the use of advisory locks for shard locking.
   */
  readonly shardLockDisableAdvisory: boolean
  /**
   * Start shutting down as soon as an Entity has started shutting down.
   *
   * Defaults to `true`.
   */
  readonly preemptiveShutdown: boolean
  /**
   * The default capacity of the mailbox for entities.
   */
  readonly entityMailboxCapacity: number | "unbounded"
  /**
   * The maximum duration of inactivity (i.e. without receiving a message)
   * after which an entity will be interrupted.
   */
  readonly entityMaxIdleTime: Duration.Input
  /**
   * If an entity does not register itself within this time after a message is
   * sent to it, the message will be marked as failed.
   *
   * Defaults to 1 minute.
   */
  readonly entityRegistrationTimeout: Duration.Input
  /**
   * The maximum duration of time to wait for an entity to terminate.
   *
   * By default this is set to 15 seconds to stay within kubernetes defaults.
   */
  readonly entityTerminationTimeout: Duration.Input
  /**
   * The interval at which to poll for unprocessed messages from storage.
   */
  readonly entityMessagePollInterval: Duration.Input
  /**
   * The interval at which to poll for client replies from storage.
   */
  readonly entityReplyPollInterval: Duration.Input
  /**
   * The interval at which to poll for new runners and refresh shard
   * assignments.
   */
  readonly refreshAssignmentsInterval: Duration.Input
  /**
   * The interval to retry a send if EntityNotAssignedToRunner is returned.
   */
  readonly sendRetryInterval: Duration.Input
  /**
   * The interval at which to check for unhealthy runners and report them
   */
  readonly runnerHealthCheckInterval: Duration.Input
  /**
   * Simulate serialization and deserialization to remote runners for local
   * entities.
   */
  readonly simulateRemoteSerialization: boolean
}>()("effect/cluster/ShardingConfig") {}

const defaultRunnerAddress = RunnerAddress.makeUnsafe({ host: "localhost", port: 34431 })

/**
 * @since 4.0.0
 * @category defaults
 */
export const defaults: ShardingConfig["Service"] = {
  runnerAddress: Option.some(defaultRunnerAddress),
  runnerListenAddress: Option.none(),
  runnerShardWeight: 1,
  shardsPerGroup: 300,
  shardGroups: ["default"],
  preemptiveShutdown: true,
  shardLockRefreshInterval: Duration.seconds(10),
  shardLockExpiration: Duration.seconds(35),
  shardLockDisableAdvisory: false,
  entityMailboxCapacity: 4096,
  entityMaxIdleTime: Duration.minutes(1),
  entityRegistrationTimeout: Duration.minutes(1),
  entityTerminationTimeout: Duration.seconds(15),
  entityMessagePollInterval: Duration.seconds(10),
  entityReplyPollInterval: Duration.millis(200),
  sendRetryInterval: Duration.millis(100),
  refreshAssignmentsInterval: Duration.seconds(3),
  runnerHealthCheckInterval: Duration.minutes(1),
  simulateRemoteSerialization: true
}

/**
 * @since 4.0.0
 * @category Layers
 */
export const layer = (options?: Partial<ShardingConfig["Service"]>): Layer.Layer<ShardingConfig> =>
  Layer.succeed(ShardingConfig)({ ...defaults, ...options })

/**
 * @since 4.0.0
 * @category defaults
 */
export const layerDefaults: Layer.Layer<ShardingConfig> = layer()

/**
 * @since 4.0.0
 * @category Config
 */
export const config: Config.Config<ShardingConfig["Service"]> = Config.all({
  runnerAddress: Config.all({
    host: Config.string("host").pipe(
      Config.withDefault(defaultRunnerAddress.host)
      // Config.withDescription("The hostname or IP address of the runner.")
    ),
    port: Config.int("port").pipe(
      Config.withDefault(defaultRunnerAddress.port)
      // Config.withDescription("The port used for inter-runner communication.")
    )
  }).pipe(Config.map((options) => RunnerAddress.makeUnsafe(options)), Config.option),
  runnerListenAddress: Config.all({
    host: Config.string("listenHost"),
    // Config.withDescription("The host to listen on.")
    port: Config.int("listenPort").pipe(
      Config.withDefault(defaultRunnerAddress.port)
      // Config.withDescription("The port to listen on.")
    )
  }).pipe(Config.map((options) => RunnerAddress.makeUnsafe(options)), Config.option),
  runnerShardWeight: Config.int("runnerShardWeight").pipe(
    Config.withDefault(defaults.runnerShardWeight)
    // Config.withDescription("A number that determines how many shards this runner will be assigned relative to other runners.")
  ),
  shardGroups: Config.schema(Schema.Array(Schema.String), "shardGroups").pipe(
    Config.withDefault(["default"])
    // Config.withDescription("The shard groups that are assigned to this runner.")
  ),
  shardsPerGroup: Config.int("shardsPerGroup").pipe(
    Config.withDefault(defaults.shardsPerGroup)
    // Config.withDescription("The number of shards to allocate per shard group.")
  ),
  shardLockRefreshInterval: Config.duration("shardLockRefreshInterval").pipe(
    Config.withDefault(defaults.shardLockRefreshInterval)
    // Config.withDescription("Shard lock refresh interval.")
  ),
  shardLockExpiration: Config.duration("shardLockExpiration").pipe(
    Config.withDefault(defaults.shardLockExpiration)
    // Config.withDescription("Shard lock expiration duration.")
  ),
  shardLockDisableAdvisory: Config.boolean("shardLockDisableAdvisory").pipe(
    Config.withDefault(defaults.shardLockDisableAdvisory)
    // Config.withDescription("Disable the use of advisory locks for shard locking.")
  ),
  preemptiveShutdown: Config.boolean("preemptiveShutdown").pipe(
    Config.withDefault(defaults.preemptiveShutdown)
    // Config.withDescription("Start shutting down as soon as an Entity has started shutting down.")
  ),
  entityMailboxCapacity: Config.int("entityMailboxCapacity").pipe(
    Config.withDefault(defaults.entityMailboxCapacity)
    // Config.withDescription("The default capacity of the mailbox for entities.")
  ),
  entityMaxIdleTime: Config.duration("entityMaxIdleTime").pipe(
    Config.withDefault(defaults.entityMaxIdleTime)
    // Config.withDescription(
    //   "The maximum duration of inactivity (i.e. without receiving a message) after which an entity will be interrupted."
    // )
  ),
  entityRegistrationTimeout: Config.duration("entityRegistrationTimeout").pipe(
    Config.withDefault(defaults.entityRegistrationTimeout)
    // Config.withDescription("If an entity does not register itself within this time after a message is sent to it, the message will be marked as failed.")
  ),
  entityTerminationTimeout: Config.duration("entityTerminationTimeout").pipe(
    Config.withDefault(defaults.entityTerminationTimeout)
    // Config.withDescription("The maximum duration of time to wait for an entity to terminate.")
  ),
  entityMessagePollInterval: Config.duration("entityMessagePollInterval").pipe(
    Config.withDefault(defaults.entityMessagePollInterval)
    // Config.withDescription("The interval at which to poll for unprocessed messages from storage.")
  ),
  entityReplyPollInterval: Config.duration("entityReplyPollInterval").pipe(
    Config.withDefault(defaults.entityReplyPollInterval)
    // Config.withDescription("The interval at which to poll for client replies from storage.")
  ),
  sendRetryInterval: Config.duration("sendRetryInterval").pipe(
    Config.withDefault(defaults.sendRetryInterval)
    // Config.withDescription("The interval to retry a send if EntityNotManagedByRunner is returned.")
  ),
  refreshAssignmentsInterval: Config.duration("refreshAssignmentsInterval").pipe(
    Config.withDefault(defaults.refreshAssignmentsInterval)
    // Config.withDescription("The interval at which to refresh shard assignments.")
  ),
  runnerHealthCheckInterval: Config.duration("runnerHealthCheckInterval").pipe(
    Config.withDefault(defaults.runnerHealthCheckInterval)
    // Config.withDescription("The interval at which to check for unhealthy runners and report them.")
  ),
  // unhealthyRunnerReportInterval: Config.duration("unhealthyRunnerReportInterval").pipe(
  simulateRemoteSerialization: Config.boolean("simulateRemoteSerialization").pipe(
    Config.withDefault(defaults.simulateRemoteSerialization)
    // Config.withDescription("Simulate serialization and deserialization to remote runners for local entities.")
  )
})

/**
 * @since 4.0.0
 * @category Config
 */
export const configFromEnv = config.asEffect().pipe(
  Effect.provideService(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromEnv().pipe(
      ConfigProvider.constantCase
    )
  )
)

/**
 * @since 4.0.0
 * @category Layers
 */
export const layerFromEnv = (options?: Partial<ShardingConfig["Service"]> | undefined): Layer.Layer<
  ShardingConfig,
  Config.ConfigError
> =>
  Layer.effect(ShardingConfig)(
    options ? Effect.map(configFromEnv, (config) => ({ ...config, ...options })) : configFromEnv
  )
