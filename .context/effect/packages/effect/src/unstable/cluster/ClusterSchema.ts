/**
 * @since 4.0.0
 */
import { constFalse, constTrue } from "../../Function.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import type { EntityId } from "./EntityId.ts"

/**
 * @since 4.0.0
 * @category Annotations
 */
export const Persisted = ServiceMap.Reference<boolean>("effect/cluster/ClusterSchema/Persisted", {
  defaultValue: constFalse
})

/**
 * @since 4.0.0
 * @category Annotations
 */
export const Uninterruptible = ServiceMap.Reference<boolean | "client" | "server">(
  "effect/cluster/ClusterSchema/Uninterruptible",
  { defaultValue: constFalse }
)

/**
 * @since 4.0.0
 * @category Annotations
 */
export const isUninterruptibleForServer = (context: ServiceMap.ServiceMap<never>): boolean => {
  const value = ServiceMap.get(context, Uninterruptible)
  return value === true || value === "server"
}

/**
 * @since 4.0.0
 * @category Annotations
 */
export const isUninterruptibleForClient = (context: ServiceMap.ServiceMap<never>): boolean => {
  const value = ServiceMap.get(context, Uninterruptible)
  return value === true || value === "client"
}

/**
 * @since 4.0.0
 * @category Annotations
 */
export const ShardGroup = ServiceMap.Reference<(entityId: EntityId) => string>(
  "effect/cluster/ClusterSchema/ShardGroup",
  { defaultValue: () => (_) => "default" }
)

/**
 * @since 4.0.0
 * @category Annotations
 */
export const ClientTracingEnabled = ServiceMap.Reference<boolean>("effect/cluster/ClusterSchema/ClientTracingEnabled", {
  defaultValue: constTrue
})
