/**
 * @since 4.0.0
 */
import * as Schema from "../../Schema.ts"

/**
 * @since 4.0.0
 * @category constructors
 */
export const EntityId = Schema.String.pipe(Schema.brand("~effect/cluster/EntityId"))

/**
 * @since 4.0.0
 * @category models
 */
export type EntityId = typeof EntityId.Type

/**
 * @since 4.0.0
 * @category constructors
 */
export const make = (id: string): EntityId => id as EntityId
