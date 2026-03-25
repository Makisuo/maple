/**
 * @since 4.0.0
 */
import * as Equal from "../../Equal.ts"
import * as Hash from "../../Hash.ts"
import * as PrimaryKey from "../../PrimaryKey.ts"
import * as S from "../../Schema.ts"

const TypeId = "~effect/cluster/ShardId"

const constDisableChecks = { disableChecks: true }

/**
 * @since 4.0.0
 * @category Constructors
 */
export const make = (group: string, id: number): ShardId => {
  const key = `${group}:${id}`
  let shardId = shardIdCache.get(key)
  if (!shardId) {
    shardId = new ShardId({ group, id }, constDisableChecks)
    shardIdCache.set(key, shardId)
  }
  return shardId
}

const shardIdCache = new Map<string, ShardId>()

/**
 * @since 4.0.0
 * @category Models
 */
export class ShardId extends S.Class<ShardId>(TypeId)({
  group: S.String,
  id: S.Int
}) {
  /**
   * @since 4.0.0
   */
  static readonly make = make

  /**
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId;

  /**
   * @since 4.0.0
   */
  [Equal.symbol](that: ShardId): boolean {
    return this.group === that.group && this.id === that.id
  }

  /**
   * @since 4.0.0
   */
  [Hash.symbol](): number {
    return Hash.string(this.toString())
  }

  /**
   * @since 4.0.0
   */
  [PrimaryKey.symbol](): string {
    return this.toString()
  }

  /**
   * @since 4.0.0
   */
  override toString(): string {
    return `${this.group}:${this.id}`
  }

  /**
   * @since 4.0.0
   */
  static override toString(shardId: {
    readonly group: string
    readonly id: number
  }): string {
    return `${shardId.group}:${shardId.id}`
  }

  /**
   * @since 4.0.0
   */
  static fromStringEncoded(s: string): {
    readonly group: string
    readonly id: number
  } {
    const index = s.lastIndexOf(":")
    if (index === -1) {
      throw new Error(`Invalid ShardId format`)
    }
    const group = s.substring(0, index)
    const id = Number(s.substring(index + 1))
    if (isNaN(id)) {
      throw new Error(`ShardId id must be a number`)
    }
    return { group, id }
  }

  /**
   * @since 4.0.0
   */
  static fromString(s: string): ShardId {
    const encoded = ShardId.fromStringEncoded(s)
    return make(encoded.group, encoded.id)
  }
}
