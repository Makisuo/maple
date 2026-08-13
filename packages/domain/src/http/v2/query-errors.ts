import {
	QueryEngineExecutionError,
	QueryEngineResultMismatchError,
	QueryEngineTimeoutError,
	QueryEngineValidationError,
} from "../query-engine"
import {
	WarehouseAuthError,
	WarehouseClientError,
	WarehouseConfigError,
	WarehouseMalformedQueryError,
	WarehouseQueryError,
	WarehouseQuotaExceededError,
	WarehouseSchemaDriftError,
	WarehouseUpstreamError,
	WarehouseValidationError,
} from "../warehouse-errors"
import { publicErrors } from "./public-error"

/** Exact public schemas for the complete WarehouseError union. */
export const V2WarehouseErrors = publicErrors(
	WarehouseQueryError,
	WarehouseUpstreamError,
	WarehouseAuthError,
	WarehouseConfigError,
	WarehouseClientError,
	WarehouseSchemaDriftError,
	WarehouseMalformedQueryError,
	WarehouseQuotaExceededError,
	WarehouseValidationError,
)

/** Exact public schemas for failures added by the higher-level query engine. */
export const V2QueryEngineErrors = publicErrors(
	QueryEngineValidationError,
	QueryEngineExecutionError,
	QueryEngineTimeoutError,
	QueryEngineResultMismatchError,
)

export const V2QueryErrors = [...V2WarehouseErrors, ...V2QueryEngineErrors] as const
