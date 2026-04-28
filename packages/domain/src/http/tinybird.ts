import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { tinybirdPipes } from "../tinybird-pipes"
import { Authorization } from "./current-tenant"

export { UnauthorizedError } from "./current-tenant"

const TinybirdPipeSchema = Schema.Literals(tinybirdPipes)

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown)

export class TinybirdQueryRequest extends Schema.Class<TinybirdQueryRequest>("TinybirdQueryRequest")({
	pipe: TinybirdPipeSchema,
	params: Schema.optionalKey(UnknownRecord),
}) {}

export class TinybirdQueryResponse extends Schema.Class<TinybirdQueryResponse>("TinybirdQueryResponse")({
	data: Schema.Array(Schema.Unknown),
}) {}

export class TinybirdQueryError extends Schema.TaggedErrorClass<TinybirdQueryError>()(
	"@maple/http/errors/TinybirdQueryError",
	{
		message: Schema.String,
		pipe: Schema.String,
	},
	{ httpApiStatus: 502 },
) {}

export class TinybirdQuotaExceededError extends Schema.TaggedErrorClass<TinybirdQuotaExceededError>()(
	"@maple/http/errors/TinybirdQuotaExceededError",
	{
		message: Schema.String,
		pipe: Schema.String,
		setting: Schema.Literals(["max_execution_time", "max_memory_usage", "max_threads"]),
	},
	{ httpApiStatus: 429 },
) {}

export class TinybirdApiGroup extends HttpApiGroup.make("tinybird")
	.add(
		HttpApiEndpoint.post("query", "/query", {
			payload: TinybirdQueryRequest,
			success: TinybirdQueryResponse,
			error: TinybirdQueryError,
		}),
	)
	.prefix("/api/tinybird")
	.middleware(Authorization) {}
