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

// `category` discriminates query failures without inflating the per-endpoint
// error union: every endpoint already declares TinybirdQueryError, so adding a
// field is free at deploy-time vs. adding new TaggedError classes (each new
// class on every endpoint costs measurable script-startup CPU on Cloudflare —
// hit error 10021 at ~7 errors × 30 endpoints).
//   - "query"         → ClickHouse/SQL error (default)
//   - "upstream"      → query backend/CDN/network failure (transient)
//   - "auth"          → upstream 401/403 or database credentials failure
//   - "config"        → backend/database configuration is wrong
//   - "client"        → Maple's query client could not decode/consume the response
//   - "schema_drift"  → BYO ClickHouse cluster is missing a column or has the
//                       wrong type for one Maple expects; remediated by running
//                       schema apply on the cluster
export class TinybirdQueryError extends Schema.TaggedErrorClass<TinybirdQueryError>()(
	"@maple/http/errors/TinybirdQueryError",
	{
		message: Schema.String,
		pipe: Schema.String,
		category: Schema.optional(
			Schema.Literals(["query", "upstream", "auth", "config", "client", "schema_drift"]),
		),
		upstreamStatus: Schema.optional(Schema.Number),
		clickhouseCode: Schema.optional(Schema.String),
		clickhouseType: Schema.optional(Schema.String),
	},
	{ httpApiStatus: 502 },
) {}

export class TinybirdQuotaExceededError extends Schema.TaggedErrorClass<TinybirdQuotaExceededError>()(
	"@maple/http/errors/TinybirdQuotaExceededError",
	{
		message: Schema.String,
		pipe: Schema.String,
		setting: Schema.Literals(["max_execution_time", "max_memory_usage", "max_threads"]),
		clickhouseCode: Schema.optional(Schema.String),
		clickhouseType: Schema.optional(Schema.String),
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
