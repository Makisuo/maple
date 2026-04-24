import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"

export class SelfManagedCollectorRepublishResponse extends Schema.Class<SelfManagedCollectorRepublishResponse>(
  "SelfManagedCollectorRepublishResponse",
)({
  published: Schema.Boolean,
  orgCount: Schema.Number,
}) {}

export class SelfManagedCollectorUnauthorizedError extends Schema.TaggedErrorClass<SelfManagedCollectorUnauthorizedError>()(
  "@maple/http/errors/SelfManagedCollectorUnauthorizedError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 401 },
) {}

export class SelfManagedCollectorRepublishError extends Schema.TaggedErrorClass<SelfManagedCollectorRepublishError>()(
  "@maple/http/errors/SelfManagedCollectorRepublishError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 503 },
) {}

export class SelfManagedCollectorApiGroup extends HttpApiGroup.make("selfManagedCollector")
  .add(
    HttpApiEndpoint.post("republish", "/republish", {
      success: SelfManagedCollectorRepublishResponse,
      error: [SelfManagedCollectorUnauthorizedError, SelfManagedCollectorRepublishError],
    }),
  )
  .prefix("/api/internal/self-managed-collector") {}
