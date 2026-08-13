import {
	QueryEngineExecutionError,
	QueryEngineResultMismatchError,
	QueryEngineTimeoutError,
	QueryEngineValidationError,
} from "../query-engine"
import { managedWarehouseHttpErrors, warehouseHttpErrors } from "../warehouse-errors"
import { publicErrors } from "./public-error"

/** Exact public schemas for the complete WarehouseError union. */
export const V2WarehouseErrors = publicErrors(...warehouseHttpErrors)

/** Managed-only routes never consult the per-org warehouse configuration. */
export const V2ManagedWarehouseErrors = publicErrors(...managedWarehouseHttpErrors)

/** Exact public schemas for failures added by the higher-level query engine. */
export const V2QueryEngineRouteErrors = publicErrors(
	QueryEngineValidationError,
	QueryEngineExecutionError,
	QueryEngineTimeoutError,
)

export const V2QueryEngineErrors = [
	...V2QueryEngineRouteErrors,
	...publicErrors(QueryEngineResultMismatchError),
] as const

export const V2QueryErrors = [...V2WarehouseErrors, ...V2QueryEngineErrors] as const
