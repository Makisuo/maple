/**
 * @since 4.0.0
 */
import * as Equal from "../../Equal.ts"
import * as Hash from "../../Hash.ts"
import { NodeInspectSymbol } from "../../Inspectable.ts"
import * as Schema from "../../Schema.ts"
import { RunnerAddress } from "./RunnerAddress.ts"

const TypeId = "~effect/cluster/Runner"

/**
 * A `Runner` represents a physical application server that is capable of running
 * entities.
 *
 * Because a Runner represents a physical application server, a Runner must have a
 * unique `address` which can be used to communicate with the server.
 *
 * The version of a Runner is used during rebalancing to give priority to newer
 * application servers and slowly decommission older ones.
 *
 * @since 4.0.0
 * @category models
 */
export class Runner extends Schema.Class<Runner>(TypeId)({
  address: RunnerAddress,
  groups: Schema.Array(Schema.String),
  weight: Schema.Number
}) {
  /**
   * @since 4.0.0
   */
  static format = Schema.toFormatter(this)

  /**
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId

  /**
   * @since 4.0.0
   */
  static readonly decodeSync = Schema.decodeSync(Schema.fromJsonString(Runner))

  /**
   * @since 4.0.0
   */
  static readonly encodeSync = Schema.encodeSync(Schema.fromJsonString(Runner))

  /**
   * @since 4.0.0
   */
  override toString(): string {
    return Runner.format(this)
  }

  /**
   * @since 4.0.0
   */
  [NodeInspectSymbol](): string {
    return this.toString()
  }

  /**
   * @since 4.0.0
   */
  [Equal.symbol](that: Runner): boolean {
    return this.address[Equal.symbol](that.address) && this.weight === that.weight
  }

  /**
   * @since 4.0.0
   */
  [Hash.symbol](): number {
    return Hash.string(`${this.address.toString()}:${this.weight}`)
  }
}

/**
 * A `Runner` represents a physical application server that is capable of running
 * entities.
 *
 * Because a Runner represents a physical application server, a Runner must have a
 * unique `address` which can be used to communicate with the server.
 *
 * The version of a Runner is used during rebalancing to give priority to newer
 * application servers and slowly decommission older ones.
 *
 * @since 4.0.0
 * @category Constructors
 */
export const make = (props: {
  readonly address: RunnerAddress
  readonly groups: ReadonlyArray<string>
  readonly weight: number
}): Runner => new Runner(props, { disableChecks: true })
