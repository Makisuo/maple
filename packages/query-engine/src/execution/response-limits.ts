export type WarehouseResponseLimitKind = "rows" | "bytes"

/** Driver-level abort used before a raw response can be fully buffered. */
export class WarehouseResponseLimitError extends Error {
	readonly _tag = "WarehouseResponseLimitError"
	readonly kind: WarehouseResponseLimitKind

	constructor(kind: WarehouseResponseLimitKind, message: string) {
		super(message)
		this.name = "WarehouseResponseLimitError"
		this.kind = kind
	}
}
