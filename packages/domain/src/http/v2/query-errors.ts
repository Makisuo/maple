import {
	QueryEngineResultMismatchError,
	QueryEngineTimeoutError,
	QueryEngineValidationError,
} from "../query-engine"
import {
	managedWarehouseHttpErrors,
	warehouseQueryHttpErrors,
	warehouseReadHttpErrors,
} from "../warehouse-errors"
import { publicErrors } from "./public-error"

/** Exact public schemas for failures that can escape compiled or raw v2 queries. */
export const V2WarehouseErrors = publicErrors(...warehouseQueryHttpErrors)

/** Managed-only routes never consult the per-org warehouse configuration. */
export const V2ManagedWarehouseErrors = publicErrors(...managedWarehouseHttpErrors)

/** Ordinary reads resolve saved settings but never mint raw-SQL access tokens. */
export const V2WarehouseReadErrors = publicErrors(...warehouseReadHttpErrors)

/** Exact public schemas for failures added by the higher-level query engine. */
export const V2QueryEngineRouteErrors = publicErrors(QueryEngineValidationError, QueryEngineTimeoutError)

export const V2QueryEngineErrors = [
	...V2QueryEngineRouteErrors,
	...publicErrors(QueryEngineResultMismatchError),
] as const

export const V2QueryErrors = [...V2WarehouseReadErrors, ...V2QueryEngineErrors] as const
