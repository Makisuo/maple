import type { Effect } from "effect"
import { warehouseErrorTags, type WarehouseError } from "@maple/domain"

/**
 * Derive an exhaustive `Effect.catchTags` table from the domain's canonical
 * class tuple. Adding a warehouse error automatically updates every consumer.
 */
export const warehouseHandlers = <A, E, R>(f: (error: WarehouseError) => Effect.Effect<A, E, R>) =>
	Object.fromEntries(warehouseErrorTags.map((tag) => [tag, f])) as Record<WarehouseError["_tag"], typeof f>
