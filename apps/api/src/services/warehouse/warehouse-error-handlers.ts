import type { Effect } from "effect"
import {
	warehouseErrorTags,
	warehouseReadErrorTags,
	type WarehouseError,
	type WarehouseReadError,
} from "@maple/domain"

const handlersFor = <Error extends WarehouseError, A, E, R>(
	tags: ReadonlyArray<Error["_tag"]>,
	f: (error: Error) => Effect.Effect<A, E, R>,
) => Object.fromEntries(tags.map((tag) => [tag, f])) as Record<Error["_tag"], typeof f>

/**
 * Derive an exhaustive `Effect.catchTags` table from the domain's canonical
 * class tuple. Adding a warehouse error automatically updates every consumer.
 */
export const warehouseHandlers = <A, E, R>(f: (error: WarehouseError) => Effect.Effect<A, E, R>) =>
	handlersFor(warehouseErrorTags, f)

/** Exhaustive handler table for compiled/read queries, excluding raw-SQL token failures. */
export const warehouseReadHandlers = <A, E, R>(f: (error: WarehouseReadError) => Effect.Effect<A, E, R>) =>
	handlersFor(warehouseReadErrorTags, f)
