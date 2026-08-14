import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { SessionAuthorization } from "./current-tenant"

export class DemoSeedRequest extends Schema.Class<DemoSeedRequest>("DemoSeedRequest")({
	hours: Schema.optional(Schema.Number),
}) {}

export class DemoSeedResponse extends Schema.Class<DemoSeedResponse>("DemoSeedResponse")({
	seeded: Schema.Boolean,
	skippedReason: Schema.NullOr(Schema.String),
	spansSent: Schema.Number,
	logsSent: Schema.Number,
	metricsSent: Schema.Number,
}) {}

export class DemoSeedError extends Schema.TaggedError<DemoSeedError>()(
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
	.prefix("/internal/demo")
	.middleware(SessionAuthorization) {}
