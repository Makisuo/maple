import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"

export class PrometheusSDTarget extends Schema.Class<PrometheusSDTarget>("PrometheusSDTarget")({
	targets: Schema.Array(Schema.String),
	labels: Schema.Record(Schema.String, Schema.String),
}) {}

export class SDUnauthorizedError extends Schema.TaggedErrorClass<SDUnauthorizedError>()(
	"@maple/http/errors/SDUnauthorizedError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 401 },
) {}

export class SDPersistenceError extends Schema.TaggedErrorClass<SDPersistenceError>()(
	"@maple/http/errors/SDPersistenceError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 503 },
) {}

export class ServiceDiscoveryApiGroup extends HttpApiGroup.make("serviceDiscovery")
	.add(
		HttpApiEndpoint.get("prometheus", "/prometheus", {
			success: Schema.Array(PrometheusSDTarget),
			error: [SDUnauthorizedError, SDPersistenceError],
		}),
	)
	.prefix("/api/internal/sd") {}
