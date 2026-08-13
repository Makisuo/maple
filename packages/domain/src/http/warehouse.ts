import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { warehouseQueries } from "../warehouse-queries"
import { Authorization } from "./current-tenant"
import { warehouseHttpErrors } from "./warehouse-errors"

export { UnauthorizedError } from "./current-tenant"

// The warehouse error classes live in the pure `./warehouse-errors` module (no
// HttpApi dependency) so non-HTTP consumers can import them. Re-export them here
// so `@maple/domain/http`'s barrel keeps surfacing every class and there is a
// single definition site (keeps `instanceof` identity-safe across import paths).
export * from "./warehouse-errors"

const WarehouseQueryNameSchema = Schema.Literals(warehouseQueries)

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown)

export class WarehouseQueryRequest extends Schema.Class<WarehouseQueryRequest>("WarehouseQueryRequest")({
	pipeName: WarehouseQueryNameSchema,
	params: Schema.optionalKey(UnknownRecord),
}) {}

export class WarehouseQueryResponse extends Schema.Class<WarehouseQueryResponse>("WarehouseQueryResponse")({
	data: Schema.Array(Schema.Unknown),
}) {}

export class WarehouseApiGroup extends HttpApiGroup.make("warehouse")
	.add(
		HttpApiEndpoint.post("query", "/query", {
			payload: WarehouseQueryRequest,
			success: WarehouseQueryResponse,
			error: warehouseHttpErrors,
		}),
	)
	.prefix("/api/tinybird")
	.middleware(Authorization) {}
