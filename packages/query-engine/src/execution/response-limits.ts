import { Schema } from "effect"

export const WarehouseResponseLimitKind = Schema.Literals(["rows", "bytes"])
export type WarehouseResponseLimitKind = Schema.Schema.Type<typeof WarehouseResponseLimitKind>

/** Driver-level abort used before a raw response can be fully buffered. */
export class WarehouseResponseLimitError extends Schema.TaggedErrorClass<WarehouseResponseLimitError>()(
	"@maple/query-engine/execution/WarehouseResponseLimitError",
	{
		kind: WarehouseResponseLimitKind,
		message: Schema.String,
	},
) {}
