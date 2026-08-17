import { Schema } from "effect"

export const WarehouseResponseLimitKind = Schema.Literals(["rows", "bytes"])
export type WarehouseResponseLimitKind = Schema.Schema.Type<typeof WarehouseResponseLimitKind>

export interface WarehouseResponseLimits {
	readonly maxRows: number
	readonly maxBytes: number
}

/** Driver-level abort used before a raw response can be fully buffered. */
export class WarehouseResponseLimitError extends Schema.TaggedError<WarehouseResponseLimitError>()(
	"@maple/query-engine/execution/WarehouseResponseLimitError",
	{
		kind: WarehouseResponseLimitKind,
		message: Schema.String,
	},
) {}
