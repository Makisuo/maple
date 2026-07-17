import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import {
	IngestAttributeMappingId,
	IngestMappingOperation,
	IngestMappingSourceContext,
} from "../../primitives"
import { AuthorizationV2, V2SchemaErrors } from "./auth"
import { ListOf, ListQuery, Timestamp } from "./envelopes"
import { V2InvalidRequestError, V2NotFoundError, V2ServiceUnavailableError } from "./errors"
import { PublicId, PublicIdPrefixes } from "./public-id"

/** See api-keys.ts: examples are authored in wire (encoded) shape. */
const wireExample = <A>(example: object): A => example as A

/** `amap_…` public ID ⇄ internal `IngestAttributeMappingId` (raw UUID). */
export const AttributeMappingPublicId = PublicId(
	PublicIdPrefixes.attributeMapping,
	IngestAttributeMappingId,
)

const NonEmptyString = Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed())

const attributeMappingExample = {
	id: "amap_YofPTrK9782DWwcnXhpcCw",
	object: "attribute_mapping",
	name: "Promote team label",
	source_context: "resource",
	source_key: "labels.team",
	target_key: "team",
	operation: "copy",
	enabled: true,
	created_at: "2026-07-01T12:00:00.000Z",
	updated_at: "2026-07-15T09:12:00.000Z",
} as const

const sourceContextField = IngestMappingSourceContext.annotate({
	description: "Where the source attribute lives: `span` (span attributes) or `resource` (resource attributes).",
	examples: ["resource"],
})

const operationField = IngestMappingOperation.annotate({
	description: "`move` renames the attribute (removes the source key); `copy` duplicates it under the target key.",
	examples: ["copy"],
})

// v2 wire schemas are annotated `Schema.Struct`s (not `Schema.Class`) — see the
// note in api-keys.ts.
export const V2AttributeMapping = Schema.Struct({
	id: AttributeMappingPublicId,
	object: Schema.Literal("attribute_mapping").annotate({
		description: 'The object type — always `"attribute_mapping"`.',
		examples: ["attribute_mapping"],
	}),
	name: Schema.String.annotate({
		description: "Human-readable label for the mapping, shown in the dashboard.",
		examples: ["Promote team label"],
	}),
	source_context: sourceContextField,
	source_key: Schema.String.annotate({
		description: "The attribute key to read from incoming telemetry.",
		examples: ["labels.team"],
	}),
	target_key: Schema.String.annotate({
		description: "The attribute key to write the value to.",
		examples: ["team"],
	}),
	operation: operationField,
	enabled: Schema.Boolean.annotate({
		description: "Whether the mapping is applied at ingest time. Disabled mappings are skipped.",
		examples: [true],
	}),
	created_at: Timestamp.annotate({ description: "When the mapping was created." }),
	updated_at: Timestamp.annotate({ description: "When the mapping was last updated." }),
}).annotate({
	identifier: "AttributeMapping",
	title: "Attribute Mapping",
	description:
		"An ingest-time attribute rewrite rule: when telemetry arrives, the value at `source_key` (in the span or resource context) is moved or copied to `target_key`. Useful for normalizing attribute names across services without redeploying them.",
	examples: [wireExample(attributeMappingExample)],
})
export type V2AttributeMapping = Schema.Schema.Type<typeof V2AttributeMapping>

export const V2AttributeMappingCreateParams = Schema.Struct({
	name: NonEmptyString.annotate({
		description: "Human-readable label for the mapping. Required, non-empty.",
		examples: ["Promote team label"],
	}),
	source_context: sourceContextField,
	source_key: NonEmptyString.annotate({
		description: "The attribute key to read from incoming telemetry. Required, non-empty.",
		examples: ["labels.team"],
	}),
	target_key: NonEmptyString.annotate({
		description: "The attribute key to write the value to. Required, non-empty.",
		examples: ["team"],
	}),
	operation: operationField,
	enabled: Schema.optionalKey(
		Schema.Boolean.annotate({
			description: "Whether the mapping starts enabled. Defaults to `true`.",
			examples: [true],
		}),
	),
}).annotate({
	identifier: "AttributeMappingCreateParams",
	title: "Attribute mapping create parameters",
	description: "Request body for creating an attribute mapping.",
	examples: [
		wireExample({
			name: "Promote team label",
			source_context: "resource",
			source_key: "labels.team",
			target_key: "team",
			operation: "copy",
			enabled: true,
		}),
	],
})
export type V2AttributeMappingCreateParams = Schema.Schema.Type<typeof V2AttributeMappingCreateParams>

export const V2AttributeMappingUpdateParams = Schema.Struct({
	name: Schema.optionalKey(NonEmptyString),
	source_context: Schema.optionalKey(sourceContextField),
	source_key: Schema.optionalKey(NonEmptyString),
	target_key: Schema.optionalKey(NonEmptyString),
	operation: Schema.optionalKey(operationField),
	enabled: Schema.optionalKey(Schema.Boolean),
}).annotate({
	identifier: "AttributeMappingUpdateParams",
	title: "Attribute mapping update parameters",
	description: "Request body for updating an attribute mapping. Omitted fields are left unchanged.",
	examples: [wireExample({ enabled: false })],
})
export type V2AttributeMappingUpdateParams = Schema.Schema.Type<typeof V2AttributeMappingUpdateParams>

export const V2AttributeMappingDeleteResponse = Schema.Struct({
	id: AttributeMappingPublicId,
	object: Schema.Literal("attribute_mapping").annotate({
		description: 'The object type — always `"attribute_mapping"`.',
	}),
	deleted: Schema.Literal(true).annotate({
		description: "Always `true` — the mapping no longer exists.",
	}),
}).annotate({
	identifier: "AttributeMappingDeleteResponse",
	title: "Attribute mapping delete response",
	description: "Confirmation that an attribute mapping was deleted.",
	examples: [
		wireExample({ id: "amap_YofPTrK9782DWwcnXhpcCw", object: "attribute_mapping", deleted: true }),
	],
})
export type V2AttributeMappingDeleteResponse = Schema.Schema.Type<typeof V2AttributeMappingDeleteResponse>

const commonErrors = [V2InvalidRequestError, V2ServiceUnavailableError] as const

const AttributeMappingList = ListOf(V2AttributeMapping).annotate({
	identifier: "AttributeMappingList",
	title: "Attribute mapping list",
	description: "A cursor-paginated page of attribute mappings.",
})

export class V2AttributeMappingsApiGroup extends HttpApiGroup.make("attributeMappings")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: ListQuery,
			success: AttributeMappingList,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listAttributeMappings",
				summary: "List attribute mappings",
				description:
					"Returns your organization's attribute mappings, most recently created first. Cursor-paginated. Requires the `attribute_mappings:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: V2AttributeMappingCreateParams,
			success: V2AttributeMapping,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createAttributeMapping",
				summary: "Create an attribute mapping",
				description:
					"Creates an ingest-time attribute rewrite rule. Requires the `attribute_mappings:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: { id: AttributeMappingPublicId },
			success: V2AttributeMapping,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getAttributeMapping",
				summary: "Retrieve an attribute mapping",
				description:
					"Returns a single attribute mapping by its `amap_…` ID. Requires the `attribute_mappings:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.patch("update", "/:id", {
			params: { id: AttributeMappingPublicId },
			payload: V2AttributeMappingUpdateParams,
			success: V2AttributeMapping,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateAttributeMapping",
				summary: "Update an attribute mapping",
				description:
					"Updates a mapping's configuration; omitted fields are unchanged. Requires the `attribute_mappings:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/:id", {
			params: { id: AttributeMappingPublicId },
			success: V2AttributeMappingDeleteResponse,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "deleteAttributeMapping",
				summary: "Delete an attribute mapping",
				description:
					"Permanently deletes an attribute mapping. Already-ingested telemetry is unaffected. Requires the `attribute_mappings:write` scope.",
			}),
		),
	)
	.prefix("/v2/attribute_mappings")
	.middleware(AuthorizationV2)
	.middleware(V2SchemaErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Attribute Mappings",
			description:
				"Ingest-time attribute rewrite rules. Move or copy span/resource attribute values to new keys as telemetry arrives, normalizing naming across services without redeploying them.",
		}),
	) {}
