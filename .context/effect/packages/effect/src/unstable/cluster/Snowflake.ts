/**
 * @since 4.0.0
 */
import type * as Brand from "../../Brand.ts"
import { Clock } from "../../Clock.ts"
import * as DateTime from "../../DateTime.ts"
import * as Effect from "../../Effect.ts"
import { identity } from "../../Function.ts"
import * as Layer from "../../Layer.ts"
import * as Schema from "../../Schema.ts"
import * as Transformation from "../../SchemaTransformation.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import type { MachineId } from "./MachineId.ts"

/**
 * @since 4.0.0
 */
export const TypeId = "~effect/cluster/Snowflake"

/**
 * @since 4.0.0
 */
export type TypeId = typeof TypeId

/**
 * @since 4.0.0
 * @category Models
 */
export type Snowflake = Brand.Branded<bigint, TypeId>

/**
 * @since 4.0.0
 * @category Models
 */
export const Snowflake = (input: string | bigint): Snowflake =>
  typeof input === "string" ? BigInt(input) as Snowflake : input as Snowflake

/**
 * @since 4.0.0
 * @category Models
 */
export declare namespace Snowflake {
  /**
   * @since 4.0.0
   * @category Models
   */
  export interface Parts {
    readonly timestamp: number
    readonly machineId: MachineId
    readonly sequence: number
  }

  /**
   * @since 4.0.0
   * @category Models
   */
  export interface Generator {
    readonly nextUnsafe: () => Snowflake
    readonly setMachineId: (machineId: MachineId) => Effect.Effect<void>
  }
}

/**
 * @since 4.0.0
 * @category Schemas
 */
export interface SnowflakeFromBigInt extends Schema.brand<Schema.BigInt, TypeId> {}

/**
 * @since 4.0.0
 * @category Schemas
 */
export const SnowflakeFromBigInt: SnowflakeFromBigInt = Schema.BigInt.pipe(Schema.brand(TypeId))

/**
 * @since 4.0.0
 * @category Schemas
 */
export interface SnowflakeFromString extends Schema.decodeTo<SnowflakeFromBigInt, Schema.String> {}

/**
 * @since 4.0.0
 * @category Schemas
 */
export const SnowflakeFromString: SnowflakeFromString = Schema.String.pipe(
  Schema.decodeTo(SnowflakeFromBigInt, Transformation.bigintFromString)
)

/**
 * @since 4.0.0
 * @category Epoch
 */
export const constEpochMillis: number = Date.UTC(2025, 0, 1)

const sinceUnixEpoch = constEpochMillis - Date.UTC(1970, 0, 1)
const constBigInt12 = BigInt(12)
const constBigInt22 = BigInt(22)
const constBigInt1024 = BigInt(1024)
const constBigInt4096 = BigInt(4096)

/**
 * @since 4.0.0
 * @category constructors
 */
export const make = (options: {
  readonly machineId: MachineId
  readonly sequence: number
  readonly timestamp: number
}): Snowflake =>
  (BigInt(options.timestamp - constEpochMillis) << constBigInt22
    | (BigInt(options.machineId % 1024) << constBigInt12)
    | BigInt(options.sequence % 4096)) as Snowflake

/**
 * @since 4.0.0
 * @category Parts
 */
export const timestamp = (snowflake: Snowflake): number => Number(snowflake >> constBigInt22) + sinceUnixEpoch

/**
 * @since 4.0.0
 * @category Parts
 */
export const dateTime = (snowflake: Snowflake): DateTime.Utc => DateTime.makeUnsafe(timestamp(snowflake))

/**
 * @since 4.0.0
 * @category Parts
 */
export const machineId = (snowflake: Snowflake): MachineId =>
  Number((snowflake >> constBigInt12) % constBigInt1024) as MachineId

/**
 * @since 4.0.0
 * @category Parts
 */
export const sequence = (snowflake: Snowflake): number => Number(snowflake % constBigInt4096)

/**
 * @since 4.0.0
 * @category Parts
 */
export const toParts = (snowflake: Snowflake): Snowflake.Parts => ({
  timestamp: timestamp(snowflake),
  machineId: machineId(snowflake),
  sequence: sequence(snowflake)
})

/**
 * @since 4.0.0
 * @category Generator
 */
export const makeGenerator: Effect.Effect<Snowflake.Generator> = Effect.gen(function*() {
  let machineId = Math.floor(Math.random() * 1024) as MachineId
  const clock = yield* Clock

  let sequence = 0
  let sequenceAt = Math.floor(clock.currentTimeMillisUnsafe())

  return identity<Snowflake.Generator>({
    setMachineId: (newMachineId) =>
      Effect.sync(() => {
        machineId = newMachineId
      }),
    nextUnsafe() {
      let now = Math.floor(clock.currentTimeMillisUnsafe())

      // account for clock drift, only allow time to move forward
      if (now < sequenceAt) {
        now = sequenceAt
      } else if (now > sequenceAt) {
        // reset sequence if we're in a new millisecond
        sequence = 0
        sequenceAt = now
      } else if (sequence >= 4096) {
        // if we've hit the max sequence for this millisecond, go to the next
        // millisecond
        sequenceAt++
        sequence = 0
      }

      return make({
        machineId,
        sequence: sequence++,
        timestamp: sequenceAt
      })
    }
  })
})

/**
 * @since 4.0.0
 * @category Generator
 */
export class Generator extends ServiceMap.Service<
  Generator,
  Snowflake.Generator
>()("effect/cluster/Snowflake/Generator") {}

/**
 * @since 4.0.0
 * @category Generator
 */
export const layerGenerator: Layer.Layer<Generator> = Layer.effect(Generator)(makeGenerator)
