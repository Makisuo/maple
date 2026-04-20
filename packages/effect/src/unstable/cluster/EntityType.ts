/**
 * @since 4.0.0
 */
import * as Schema from "../../Schema.ts"

/**
 * @since 4.0.0
 * @category constructors
 */
export const EntityType = Schema.String.pipe(Schema.brand("~effect/cluster/EntityType"))

/**
 * @since 4.0.0
 * @category models
 */
export type EntityType = typeof EntityType.Type

/**
 * @since 4.0.0
 * @category constructors
 */
export const make = (value: string): EntityType => value as EntityType
