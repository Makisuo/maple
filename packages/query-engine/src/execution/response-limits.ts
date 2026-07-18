import { WarehouseValidationError } from "@maple/domain/http"

export const RAW_SQL_RESPONSE_LIMIT_TYPE = "RAW_SQL_RESPONSE_LIMIT"

export type WarehouseResponseLimitKind = "rows" | "bytes"

/** Driver-level abort used before a raw response can be fully buffered. */
export class WarehouseResponseLimitError extends Error {
	readonly kind: WarehouseResponseLimitKind

	constructor(kind: WarehouseResponseLimitKind, message: string) {
		super(message)
		this.name = "WarehouseResponseLimitError"
		this.kind = kind
	}
}

export const isRawSqlResponseLimitError = (error: unknown): error is WarehouseValidationError =>
	error instanceof WarehouseValidationError && error.clickhouseType === RAW_SQL_RESPONSE_LIMIT_TYPE
