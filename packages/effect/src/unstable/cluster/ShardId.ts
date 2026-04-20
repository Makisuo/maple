/**
 * @since 4.0.0
 */
import * as Equal from "../../Equal.ts"
import * as Hash from "../../Hash.ts"
import { hasProperty } from "../../Predicate.ts"
import * as PrimaryKey from "../../PrimaryKey.ts"
import * as S from "../../Schema.ts"
import * as Getter from "../../SchemaGetter.ts"

const TypeId = "~effect/cluster/ShardId"

/**
 * @since 4.0.0
 * @category Models
 */
export interface ShardId extends Equal.Equal, Hash.Hash, PrimaryKey.PrimaryKey {
  readonly [TypeId]: typeof TypeId
  readonly group: string
  readonly id: number
}

/**
 * @since 4.0.0
 * @category Guards
 */
export const isShardId = (u: unknown): u is ShardId => hasProperty(u, TypeId)

/**
 * @since 4.0.0
 * @category Schema
 */
export const ShardId = S.declare(isShardId, {
  toCodecJson: () =>
    S.link<ShardId>()(
      S.Struct({
        group: S.String,
        id: S.Number
      }),
      {
        decode: Getter.transform(({ group, id }) => make(group, id)),
        encode: Getter.passthrough()
      }
    )
})

/**
 * @since 4.0.0
 * @category Constructors
 */
export const make = (group: string, id: number): ShardId => {
  const key = `${group}:${id}`
  let shardId = shardIdCache.get(key)
  if (!shardId) {
    shardId = makeProto(group, id)
    shardIdCache.set(key, shardId)
  }
  return shardId
}

const shardIdCache = new Map<string, ShardId>()

const makeProto = (group: string, id: number): ShardId => {
  const self = Object.create(ShardIdProto)
  self.group = group
  self.id = id
  return self
}

const ShardIdProto = {
  [TypeId]: TypeId,
  [Equal.symbol](this: ShardId, that: ShardId): boolean {
    return this.group === that.group && this.id === that.id
  },
  [Hash.symbol](this: ShardId): number {
    return Hash.string(this.toString())
  },
  [PrimaryKey.symbol](this: ShardId): string {
    return this.toString()
  },
  toString(this: ShardId): string {
    return `${this.group}:${this.id}`
  }
}

/**
 * @since 4.0.0
 * @category Conversions
 */
export const toString = (shardId: {
  readonly group: string
  readonly id: number
}): string => {
  return `${shardId.group}:${shardId.id}`
}
/**
 * @since 4.0.0
 */
export function fromStringEncoded(s: string): {
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
export function fromString(s: string): ShardId {
  const encoded = fromStringEncoded(s)
  return make(encoded.group, encoded.id)
}
