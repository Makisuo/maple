import { HttpApiBuilder } from "effect/unstable/httpapi"
import type {
	IngestAttributeMapping,
	IngestAttributeMappingId,
	IngestAttributeMappingNotFoundError,
	IngestAttributeMappingPersistenceError,
	IngestAttributeMappingValidationError,
	OrgId,
} from "@maple/domain/http"
import {
	CreateIngestAttributeMappingRequest,
	CurrentTenant,
	UpdateIngestAttributeMappingRequest,
} from "@maple/domain/http"
import {
	MapleApiV2,
	dependencyUnavailable,
	invalidRequest,
	paginateArray,
	resourceNotFound,
} from "@maple/domain/http/v2"
import type {
	V2AttributeMapping,
	V2InvalidRequestError,
	V2NotFoundError,
	V2ServiceUnavailableError,
} from "@maple/domain/http/v2"
import { Array as Arr, Effect, Option } from "effect"
import { IngestAttributeMappingService } from "../../services/IngestAttributeMappingService"

const toV2AttributeMapping = (mapping: IngestAttributeMapping): V2AttributeMapping => ({
	id: mapping.id,
	object: "attribute_mapping",
	name: mapping.name,
	source_context: mapping.sourceContext,
	source_key: mapping.sourceKey,
	target_key: mapping.targetKey,
	operation: mapping.operation,
	enabled: mapping.enabled,
	created_at: mapping.createdAt,
	updated_at: mapping.updatedAt,
})

/** Service tagged errors → v2 envelope errors (endpoints without a 404). */
const mapCommonError =
	(operation: string) =>
	<A, R>(
		effect: Effect.Effect<
			A,
			IngestAttributeMappingValidationError | IngestAttributeMappingPersistenceError,
			R
		>,
	): Effect.Effect<A, V2InvalidRequestError | V2ServiceUnavailableError, R> =>
		effect.pipe(
			Effect.catchTags({
				"@maple/http/errors/IngestAttributeMappingValidationError": (error) =>
					Effect.fail(invalidRequest("parameter_invalid", error.message)),
				"@maple/http/errors/IngestAttributeMappingPersistenceError": () =>
					Effect.fail(dependencyUnavailable(`attribute_mapping_${operation}_unavailable`)),
			}),
		)

/** Service tagged errors → v2 envelope errors (endpoints with a 404). */
const mapMutationError =
	(operation: string) =>
	<A, R>(
		effect: Effect.Effect<
			A,
			| IngestAttributeMappingNotFoundError
			| IngestAttributeMappingValidationError
			| IngestAttributeMappingPersistenceError,
			R
		>,
	): Effect.Effect<A, V2NotFoundError | V2InvalidRequestError | V2ServiceUnavailableError, R> =>
		effect.pipe(
			Effect.catchTags({
				"@maple/http/errors/IngestAttributeMappingNotFoundError": () =>
					Effect.fail(resourceNotFound("attribute_mapping", "No such attribute mapping.")),
				"@maple/http/errors/IngestAttributeMappingValidationError": (error) =>
					Effect.fail(invalidRequest("parameter_invalid", error.message)),
				"@maple/http/errors/IngestAttributeMappingPersistenceError": () =>
					Effect.fail(dependencyUnavailable(`attribute_mapping_${operation}_unavailable`)),
			}),
		)

const mapPersistenceError = <A, R>(
	effect: Effect.Effect<A, IngestAttributeMappingPersistenceError, R>,
): Effect.Effect<A, V2ServiceUnavailableError, R> =>
	effect.pipe(
		Effect.catchTag("@maple/http/errors/IngestAttributeMappingPersistenceError", () =>
			Effect.fail(dependencyUnavailable("attribute_mapping_list_unavailable")),
		),
	)

export const HttpV2AttributeMappingsLive = HttpApiBuilder.group(MapleApiV2, "attributeMappings", (handlers) =>
	Effect.gen(function* () {
		const service = yield* IngestAttributeMappingService

		const listMappings = (orgId: OrgId) => service.list(orgId).pipe(mapPersistenceError)

		const findMapping = (orgId: OrgId, id: IngestAttributeMappingId) =>
			listMappings(orgId).pipe(
				Effect.flatMap((response) =>
					Option.match(
						Arr.findFirst(response.mappings, (candidate) => candidate.id === id),
						{
							onNone: () =>
								Effect.fail(
									resourceNotFound("attribute_mapping", "No such attribute mapping."),
								),
							onSome: Effect.succeed,
						},
					),
				),
			)

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const response = yield* listMappings(tenant.orgId)
					const page = yield* paginateArray(response.mappings.map(toV2AttributeMapping), query)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const mapping = yield* findMapping(tenant.orgId, params.id)
					return toV2AttributeMapping(mapping)
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const created = yield* service
						.create(
							tenant.orgId,
							new CreateIngestAttributeMappingRequest({
								name: payload.name,
								sourceContext: payload.source_context,
								sourceKey: payload.source_key,
								targetKey: payload.target_key,
								operation: payload.operation,
								...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
							}),
						)
						.pipe(mapCommonError("create"))
					return toV2AttributeMapping(created)
				}),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const updated = yield* service
						.update(
							tenant.orgId,
							params.id,
							new UpdateIngestAttributeMappingRequest({
								...(payload.name !== undefined ? { name: payload.name } : {}),
								...(payload.source_context !== undefined
									? { sourceContext: payload.source_context }
									: {}),
								...(payload.source_key !== undefined
									? { sourceKey: payload.source_key }
									: {}),
								...(payload.target_key !== undefined
									? { targetKey: payload.target_key }
									: {}),
								...(payload.operation !== undefined ? { operation: payload.operation } : {}),
								...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
							}),
						)
						.pipe(mapMutationError("update"))
					return toV2AttributeMapping(updated)
				}),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const deleted = yield* service
						.delete(tenant.orgId, params.id)
						.pipe(mapMutationError("delete"))
					return { id: deleted.id, object: "attribute_mapping" as const, deleted: true as const }
				}),
			)
	}),
)
