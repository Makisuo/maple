/**
 * @since 4.0.0
 */
import * as Data from "../../Data.ts"
import type { Entity } from "./Entity.ts"
import type { SingletonAddress } from "./SingletonAddress.ts"

/**
 * Represents events that can occur when a runner registers entities or singletons.
 *
 * @since 4.0.0
 * @category models
 */
export type ShardingRegistrationEvent =
  | EntityRegistered
  | SingletonRegistered

/**
 * Represents an event that occurs when a new entity is registered with a runner.
 *
 * @since 4.0.0
 * @category models
 */
export interface EntityRegistered {
  readonly _tag: "EntityRegistered"
  readonly entity: Entity<any, any>
}

/**
 * Represents an event that occurs when a new singleton is registered with a
 * runner.
 *
 * @since 4.0.0
 * @category models
 */
export interface SingletonRegistered {
  readonly _tag: "SingletonRegistered"
  readonly address: SingletonAddress
}

/**
 * @since 4.0.0
 * @category pattern matching
 */
export const {
  /**
   * @since 4.0.0
   * @category pattern matching
   */
  $match: match,
  /**
   * @since 4.0.0
   * @category constructors
   */
  EntityRegistered,
  /**
   * @since 4.0.0
   * @category constructors
   */
  SingletonRegistered
} = Data.taggedEnum<ShardingRegistrationEvent>()
