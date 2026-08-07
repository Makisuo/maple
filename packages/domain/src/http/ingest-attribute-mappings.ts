import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import {
	IngestAttributeMappingId,
	IngestMappingOperation,
	IngestMappingSourceContext,
	IsoDateTimeString,
} from "../primitives"
import { Authorization } from "./current-tenant"

export class IngestAttributeMapping extends Schema.Class<IngestAttributeMapping>("IngestAttributeMapping")({
	id: IngestAttributeMappingId,
	name: Schema.String,
	sourceContext: IngestMappingSourceContext,
	sourceKey: Schema.String,
	targetKey: Schema.String,
	operation: IngestMappingOperation,
	enabled: Schema.Boolean,
	createdAt: IsoDateTimeString,
	updatedAt: IsoDateTimeString,
}) {}

export class IngestAttributeMappingsListResponse extends Schema.Class<IngestAttributeMappingsListResponse>(
	"IngestAttributeMappingsListResponse",
)({
	mappings: Schema.Array(IngestAttributeMapping),
}) {}

export class CreateIngestAttributeMappingRequest extends Schema.Class<CreateIngestAttributeMappingRequest>(
	"CreateIngestAttributeMappingRequest",
)({
	name: Schema.String,
	sourceContext: IngestMappingSourceContext,
	sourceKey: Schema.String,
	targetKey: Schema.String,
	operation: IngestMappingOperation,
	enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export class UpdateIngestAttributeMappingRequest extends Schema.Class<UpdateIngestAttributeMappingRequest>(
	"UpdateIngestAttributeMappingRequest",
)({
	name: Schema.optionalKey(Schema.String),
	sourceContext: Schema.optionalKey(IngestMappingSourceContext),
	sourceKey: Schema.optionalKey(Schema.String),
	targetKey: Schema.optionalKey(Schema.String),
	operation: Schema.optionalKey(IngestMappingOperation),
	enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export class IngestAttributeMappingDeleteResponse extends Schema.Class<IngestAttributeMappingDeleteResponse>(
	"IngestAttributeMappingDeleteResponse",
)({
	id: IngestAttributeMappingId,
}) {}

export class IngestAttributeMappingPersistenceError extends Schema.TaggedError<IngestAttributeMappingPersistenceError>()(
	"@maple/http/errors/IngestAttributeMappingPersistenceError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 503 },
) {}

export class IngestAttributeMappingNotFoundError extends Schema.TaggedError<IngestAttributeMappingNotFoundError>()(
	"@maple/http/errors/IngestAttributeMappingNotFoundError",
	{
		mappingId: IngestAttributeMappingId,
		message: Schema.String,
	},
	{ httpApiStatus: 404 },
) {}

export class IngestAttributeMappingValidationError extends Schema.TaggedError<IngestAttributeMappingValidationError>()(
	"@maple/http/errors/IngestAttributeMappingValidationError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

export class IngestAttributeMappingsApiGroup extends HttpApiGroup.make("ingestAttributeMappings")
	.add(
		HttpApiEndpoint.get("list", "/", {
			success: IngestAttributeMappingsListResponse,
			error: IngestAttributeMappingPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: CreateIngestAttributeMappingRequest,
			success: IngestAttributeMapping,
			error: [IngestAttributeMappingValidationError, IngestAttributeMappingPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.patch("update", "/:mappingId", {
			params: {
				mappingId: IngestAttributeMappingId,
			},
			payload: UpdateIngestAttributeMappingRequest,
			success: IngestAttributeMapping,
			error: [
				IngestAttributeMappingNotFoundError,
				IngestAttributeMappingValidationError,
				IngestAttributeMappingPersistenceError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/:mappingId", {
			params: {
				mappingId: IngestAttributeMappingId,
			},
			success: IngestAttributeMappingDeleteResponse,
			error: [IngestAttributeMappingNotFoundError, IngestAttributeMappingPersistenceError],
		}),
	)
	.prefix("/api/ingest-attribute-mappings")
	.middleware(Authorization) {}
