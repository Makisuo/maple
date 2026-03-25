/**
 * @since 4.0.0
 */
import * as Equal from "../../Equal.ts"
import * as Hash from "../../Hash.ts"
import * as Schema from "../../Schema.ts"
import { ShardId } from "./ShardId.ts"

const TypeId = "~effect/cluster/SingletonAddress"

/**
 * Represents the unique address of an singleton within the cluster.
 *
 * @since 4.0.0
 * @category Address
 */
export class SingletonAddress extends Schema.Class<SingletonAddress>(TypeId)({
  shardId: ShardId,
  name: Schema.String
}) {
  /**
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId;
  /**
   * @since 4.0.0
   */
  [Hash.symbol]() {
    return Hash.string(`${this.name}:${this.shardId.toString()}`)
  }
  /**
   * @since 4.0.0
   */
  [Equal.symbol](that: SingletonAddress): boolean {
    return this.name === that.name && Equal.equals(this.shardId, that.shardId)
  }
}
