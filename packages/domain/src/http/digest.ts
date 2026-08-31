import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { SessionAuthorization } from "./current-tenant"

export const DigestSubscriptionId = Schema.String.check(Schema.isUUID()).pipe(
	Schema.brand("@maple/DigestSubscriptionId"),
	Schema.annotate({
		identifier: "@maple/DigestSubscriptionId",
		title: "Digest Subscription ID",
	}),
)
export type DigestSubscriptionId = Schema.Schema.Type<typeof DigestSubscriptionId>

export class DigestSubscriptionResponse extends Schema.Class<DigestSubscriptionResponse>(
	"DigestSubscriptionResponse",
)({
	id: DigestSubscriptionId,
	email: Schema.String,
	enabled: Schema.Boolean,
	dayOfWeek: Schema.Number,
	timezone: Schema.String,
	/** Empty = every namespace / environment. */
	namespaces: Schema.Array(Schema.String),
	environments: Schema.Array(Schema.String),
	lastSentAt: Schema.NullOr(Schema.Number),
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
}) {}

/**
 * A scope is a pick-list of values the org actually reports, so a handful of
 * short strings. Bounded at the boundary because every stored scope is later
 * sorted, joined into query params, logged and rendered on each digest tick —
 * an unbounded array would let one subscriber inflate all of that.
 */
const ScopeValues = Schema.Array(Schema.String.check(Schema.isMaxLength(200))).check(Schema.isMaxLength(50))

export class UpsertDigestSubscriptionRequest extends Schema.Class<UpsertDigestSubscriptionRequest>(
	"UpsertDigestSubscriptionRequest",
)({
	email: Schema.String,
	enabled: Schema.optionalKey(Schema.Boolean),
	dayOfWeek: Schema.optionalKey(Schema.Number),
	timezone: Schema.optionalKey(Schema.String),
	namespaces: Schema.optionalKey(ScopeValues),
	environments: Schema.optionalKey(ScopeValues),
}) {}

export class DigestPreviewResponse extends Schema.Class<DigestPreviewResponse>("DigestPreviewResponse")({
	html: Schema.String,
}) {}

export class DigestPersistenceError extends Schema.TaggedError<DigestPersistenceError>()(
	"@maple/http/errors/DigestPersistenceError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 503 },
) {}

export class DigestNotFoundError extends Schema.TaggedError<DigestNotFoundError>()(
	"@maple/http/errors/DigestNotFoundError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 404 },
) {}

export class DigestNotConfiguredError extends Schema.TaggedError<DigestNotConfiguredError>()(
	"@maple/http/errors/DigestNotConfiguredError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 501 },
) {}

export class DigestRenderError extends Schema.TaggedError<DigestRenderError>()(
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
	.prefix("/internal/digest")
	.middleware(SessionAuthorization) {}
