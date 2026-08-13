import { Schema } from "effect"
import {
	IngestAttributeMappingId,
	IngestMappingOperation,
	IngestMappingSourceContext,
	IsoDateTimeString,
} from "../primitives"
import { HttpTaggedError } from "./error-policy"

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

export class IngestAttributeMappingPersistenceError extends HttpTaggedError<IngestAttributeMappingPersistenceError>()(
	"@maple/http/errors/IngestAttributeMappingPersistenceError",
	{
		message: Schema.String,
	},
	{
		status: 503,
		code: "attribute_mappings_unavailable",
		title: "Attribute mappings are temporarily unavailable",
		message: "Attribute mappings are temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export class IngestAttributeMappingNotFoundError extends HttpTaggedError<IngestAttributeMappingNotFoundError>()(
	"@maple/http/errors/IngestAttributeMappingNotFoundError",
	{
		mappingId: IngestAttributeMappingId,
		message: Schema.String,
	},
	{
		status: 404,
		code: "attribute_mapping_not_found",
		title: "Attribute mapping not found",
		message: "No such attribute mapping.",
		param: "id",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

export class IngestAttributeMappingValidationError extends HttpTaggedError<IngestAttributeMappingValidationError>()(
	"@maple/http/errors/IngestAttributeMappingValidationError",
	{
		message: Schema.String,
	},
	{
		status: 400,
		code: "attribute_mapping_invalid",
		title: "Invalid attribute mapping",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}
