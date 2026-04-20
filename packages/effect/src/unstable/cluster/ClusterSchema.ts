/**
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import { constFalse, constTrue, identity } from "../../Function.ts"
import type * as Rpc from "../rpc/Rpc.ts"
import type { EntityId } from "./EntityId.ts"
import type { Request } from "./Envelope.ts"

/**
 * @since 4.0.0
 * @category Annotations
 */
export const Persisted = Context.Reference<boolean>("effect/cluster/ClusterSchema/Persisted", {
  defaultValue: constFalse
})

/**
 * Whether to wrap the request with a storage transaction, so sql queries are
 * committed atomically.
 *
 * @since 4.0.0
 * @category Annotations
 */
export const WithTransaction = Context.Reference<boolean>(
  "effect/cluster/ClusterSchema/WithTransaction",
  { defaultValue: constFalse }
)

/**
 * @since 4.0.0
 * @category Annotations
 */
export const Uninterruptible = Context.Reference<boolean | "client" | "server">(
  "effect/cluster/ClusterSchema/Uninterruptible",
  { defaultValue: constFalse }
)

/**
 * @since 4.0.0
 * @category Annotations
 */
export const isUninterruptibleForServer = (context: Context.Context<never>): boolean => {
  const value = Context.get(context, Uninterruptible)
  return value === true || value === "server"
}

/**
 * @since 4.0.0
 * @category Annotations
 */
export const isUninterruptibleForClient = (context: Context.Context<never>): boolean => {
  const value = Context.get(context, Uninterruptible)
  return value === true || value === "client"
}

/**
 * @since 4.0.0
 * @category Annotations
 */
export const ShardGroup = Context.Reference<(entityId: EntityId) => string>(
  "effect/cluster/ClusterSchema/ShardGroup",
  { defaultValue: () => (_) => "default" }
)

/**
 * @since 4.0.0
 * @category Annotations
 */
export const ClientTracingEnabled = Context.Reference<boolean>("effect/cluster/ClusterSchema/ClientTracingEnabled", {
  defaultValue: constTrue
})

/**
 * Dynamically transform the request annotations based on the request.
 * This only applies to the requests handled by the Entity, not the client.
 *
 * @since 4.0.0
 * @category Annotations
 */
export const Dynamic = Context.Reference<
  (annotations: Context.Context<never>, request: Request<Rpc.AnyWithProps>) => Context.Context<never>
>(
  "effect/cluster/ClusterSchema/Dynamic",
  { defaultValue: () => identity }
)
