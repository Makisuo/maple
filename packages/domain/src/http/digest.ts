import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "./current-tenant"

export const DigestSubscriptionId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("@maple/DigestSubscriptionId"),
  Schema.annotate({
    identifier: "@maple/DigestSubscriptionId",
    title: "Digest Subscription ID",
  }),
)
export type DigestSubscriptionId = Schema.Schema.Type<
  typeof DigestSubscriptionId
>

export class DigestSubscriptionResponse extends Schema.Class<DigestSubscriptionResponse>(
  "DigestSubscriptionResponse",
)({
  id: DigestSubscriptionId,
  email: Schema.String,
  enabled: Schema.Boolean,
  dayOfWeek: Schema.Number,
  timezone: Schema.String,
  lastSentAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
}) {}

export class UpsertDigestSubscriptionRequest extends Schema.Class<UpsertDigestSubscriptionRequest>(
  "UpsertDigestSubscriptionRequest",
)({
  email: Schema.String,
  enabled: Schema.optional(Schema.Boolean),
  dayOfWeek: Schema.optional(Schema.Number),
  timezone: Schema.optional(Schema.String),
}) {}

export class DigestPreviewResponse extends Schema.Class<DigestPreviewResponse>(
  "DigestPreviewResponse",
)({
  html: Schema.String,
}) {}

export class DigestPersistenceError extends Schema.TaggedErrorClass<DigestPersistenceError>()(
  "@maple/http/errors/DigestPersistenceError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 503 },
) {}

export class DigestNotFoundError extends Schema.TaggedErrorClass<DigestNotFoundError>()(
  "@maple/http/errors/DigestNotFoundError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class DigestNotConfiguredError extends Schema.TaggedErrorClass<DigestNotConfiguredError>()(
  "@maple/http/errors/DigestNotConfiguredError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 501 },
) {}

export class DigestRenderError extends Schema.TaggedErrorClass<DigestRenderError>()(
  "@maple/http/errors/DigestRenderError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {}

export class DigestApiGroup extends HttpApiGroup.make("digest")
  .add(
    HttpApiEndpoint.get("getSubscription", "/", {
      success: DigestSubscriptionResponse,
      error: [DigestPersistenceError, DigestNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.post("upsertSubscription", "/", {
      payload: UpsertDigestSubscriptionRequest,
      success: DigestSubscriptionResponse,
      error: [DigestPersistenceError, DigestNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteSubscription", "/", {
      success: Schema.Void,
      error: DigestPersistenceError,
    }),
  )
  .add(
    HttpApiEndpoint.post("preview", "/preview", {
      success: DigestPreviewResponse,
      error: [DigestPersistenceError, DigestNotConfiguredError, DigestRenderError],
    }),
  )
  .prefix("/api/digest")
  .middleware(Authorization) {}
