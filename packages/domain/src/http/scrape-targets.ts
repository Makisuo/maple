import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { IsoDateTimeString, ScrapeAuthType, ScrapeIntervalSeconds, ScrapeTargetId } from "../primitives"
import { Authorization } from "./current-tenant"

export class ScrapeTargetResponse extends Schema.Class<ScrapeTargetResponse>("ScrapeTargetResponse")({
	id: ScrapeTargetId,
	name: Schema.String,
	serviceName: Schema.NullOr(Schema.String),
	url: Schema.String,
	scrapeIntervalSeconds: ScrapeIntervalSeconds,
	labelsJson: Schema.NullOr(Schema.String),
	authType: ScrapeAuthType,
	hasCredentials: Schema.Boolean,
	enabled: Schema.Boolean,
	lastScrapeAt: Schema.NullOr(IsoDateTimeString),
	lastScrapeError: Schema.NullOr(Schema.String),
	createdAt: IsoDateTimeString,
	updatedAt: IsoDateTimeString,
}) {}

export class ScrapeTargetsListResponse extends Schema.Class<ScrapeTargetsListResponse>(
	"ScrapeTargetsListResponse",
)({
	targets: Schema.Array(ScrapeTargetResponse),
}) {}

export class CreateScrapeTargetRequest extends Schema.Class<CreateScrapeTargetRequest>(
	"CreateScrapeTargetRequest",
)({
	name: Schema.String,
	url: Schema.String,
	scrapeIntervalSeconds: Schema.optional(ScrapeIntervalSeconds),
	labelsJson: Schema.optional(Schema.NullOr(Schema.String)),
	authType: Schema.optional(ScrapeAuthType),
	serviceName: Schema.optional(Schema.NullOr(Schema.String)),
	authCredentials: Schema.optional(Schema.NullOr(Schema.String)),
	enabled: Schema.optional(Schema.Boolean),
}) {}

export class UpdateScrapeTargetRequest extends Schema.Class<UpdateScrapeTargetRequest>(
	"UpdateScrapeTargetRequest",
)({
	name: Schema.optional(Schema.String),
	url: Schema.optional(Schema.String),
	scrapeIntervalSeconds: Schema.optional(ScrapeIntervalSeconds),
	labelsJson: Schema.optional(Schema.NullOr(Schema.String)),
	authType: Schema.optional(ScrapeAuthType),
	serviceName: Schema.optional(Schema.NullOr(Schema.String)),
	authCredentials: Schema.optional(Schema.NullOr(Schema.String)),
	enabled: Schema.optional(Schema.Boolean),
}) {}

export class ScrapeTargetDeleteResponse extends Schema.Class<ScrapeTargetDeleteResponse>(
	"ScrapeTargetDeleteResponse",
)({
	id: ScrapeTargetId,
}) {}

export class ScrapeTargetProbeResponse extends Schema.Class<ScrapeTargetProbeResponse>(
	"ScrapeTargetProbeResponse",
)({
	success: Schema.Boolean,
	lastScrapeAt: Schema.NullOr(IsoDateTimeString),
	lastScrapeError: Schema.NullOr(Schema.String),
}) {}

export class ScrapeTargetPersistenceError extends Schema.TaggedErrorClass<ScrapeTargetPersistenceError>()(
	"@maple/http/errors/ScrapeTargetPersistenceError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 503 },
) {}

export class ScrapeTargetNotFoundError extends Schema.TaggedErrorClass<ScrapeTargetNotFoundError>()(
	"@maple/http/errors/ScrapeTargetNotFoundError",
	{
		targetId: ScrapeTargetId,
		message: Schema.String,
	},
	{ httpApiStatus: 404 },
) {}

export class ScrapeTargetValidationError extends Schema.TaggedErrorClass<ScrapeTargetValidationError>()(
	"@maple/http/errors/ScrapeTargetValidationError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

export class ScrapeTargetEncryptionError extends Schema.TaggedErrorClass<ScrapeTargetEncryptionError>()(
	"@maple/http/errors/ScrapeTargetEncryptionError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 500 },
) {}

export class ScrapeTargetsApiGroup extends HttpApiGroup.make("scrapeTargets")
	.add(
		HttpApiEndpoint.get("list", "/", {
			success: ScrapeTargetsListResponse,
			error: ScrapeTargetPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: CreateScrapeTargetRequest,
			success: ScrapeTargetResponse,
			error: [ScrapeTargetValidationError, ScrapeTargetPersistenceError, ScrapeTargetEncryptionError],
		}),
	)
	.add(
		HttpApiEndpoint.patch("update", "/:targetId", {
			params: {
				targetId: ScrapeTargetId,
			},
			payload: UpdateScrapeTargetRequest,
			success: ScrapeTargetResponse,
			error: [
				ScrapeTargetNotFoundError,
				ScrapeTargetValidationError,
				ScrapeTargetPersistenceError,
				ScrapeTargetEncryptionError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/:targetId", {
			params: {
				targetId: ScrapeTargetId,
			},
			success: ScrapeTargetDeleteResponse,
			error: [ScrapeTargetNotFoundError, ScrapeTargetPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.post("probe", "/:targetId/probe", {
			params: {
				targetId: ScrapeTargetId,
			},
			success: ScrapeTargetProbeResponse,
			error: [ScrapeTargetNotFoundError, ScrapeTargetPersistenceError, ScrapeTargetEncryptionError],
		}),
	)
	.prefix("/api/scrape-targets")
	.middleware(Authorization) {}
