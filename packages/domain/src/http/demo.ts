import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "./current-tenant"

export class DemoSeedRequest extends Schema.Class<DemoSeedRequest>("DemoSeedRequest")({
	hours: Schema.optionalKey(Schema.Number),
}) {}

export class DemoSeedResponse extends Schema.Class<DemoSeedResponse>("DemoSeedResponse")({
	seeded: Schema.Boolean,
	skippedReason: Schema.NullOr(Schema.String),
	spansSent: Schema.Number,
	logsSent: Schema.Number,
	metricsSent: Schema.Number,
}) {}

export class DemoSeedError extends Schema.TaggedErrorClass<DemoSeedError>()(
	"@maple/http/errors/DemoSeedError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 500 },
) {}

export class DemoApiGroup extends HttpApiGroup.make("demo")
	.add(
		HttpApiEndpoint.post("seed", "/seed", {
			payload: DemoSeedRequest,
			success: DemoSeedResponse,
			error: DemoSeedError,
		}),
	)
	.prefix("/api/demo")
	.middleware(Authorization) {}
