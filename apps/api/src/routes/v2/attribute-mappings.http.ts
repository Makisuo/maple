import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { IngestAttributeMapping, IngestAttributeMappingId, OrgId } from "@maple/domain/http"
import {
	CreateIngestAttributeMappingRequest,
	CurrentTenant,
	UpdateIngestAttributeMappingRequest,
} from "@maple/domain/http"
import {
	MapleApiV2,
	invalidRequest,
	notFound,
	paginateArray,
	serviceUnavailable,
} from "@maple/domain/http/v2"
import type { V2AttributeMapping } from "@maple/domain/http/v2"
import { Effect } from "effect"
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
const mapCommonError = (error: { readonly _tag: string; readonly message: string }) =>
	error._tag === "@maple/http/errors/IngestAttributeMappingValidationError"
		? invalidRequest("parameter_invalid", error.message)
		: serviceUnavailable(error.message)

/** Service tagged errors → v2 envelope errors (endpoints with a 404). */
const mapMutationError = (error: { readonly _tag: string; readonly message: string }) =>
	error._tag === "@maple/http/errors/IngestAttributeMappingNotFoundError"
		? notFound(error.message, "id")
		: mapCommonError(error)

const mapPersistenceError = (error: { readonly message: string }) => serviceUnavailable(error.message)

export const HttpV2AttributeMappingsLive = HttpApiBuilder.group(
	MapleApiV2,
	"attributeMappings",
	(handlers) =>
		Effect.gen(function* () {
			const service = yield* IngestAttributeMappingService

			const listMappings = (orgId: OrgId) =>
				service.list(orgId).pipe(Effect.mapError(mapPersistenceError))

			const findMapping = (orgId: OrgId, id: IngestAttributeMappingId) =>
				listMappings(orgId).pipe(
					Effect.flatMap((response) => {
						const mapping = response.mappings.find((candidate) => candidate.id === id)
						return mapping === undefined
							? Effect.fail(notFound("No such attribute_mapping.", "id"))
							: Effect.succeed(mapping)
					}),
				)

			return handlers
				.handle("list", ({ query }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const response = yield* listMappings(tenant.orgId)
						const page = paginateArray(response.mappings.map(toV2AttributeMapping), query)
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
							.pipe(Effect.mapError(mapCommonError))
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
									...(payload.source_key !== undefined ? { sourceKey: payload.source_key } : {}),
									...(payload.target_key !== undefined ? { targetKey: payload.target_key } : {}),
									...(payload.operation !== undefined ? { operation: payload.operation } : {}),
									...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
								}),
							)
							.pipe(Effect.mapError(mapMutationError))
						return toV2AttributeMapping(updated)
					}),
				)
				.handle("delete", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const deleted = yield* service
							.delete(tenant.orgId, params.id)
							.pipe(Effect.mapError(mapMutationError))
						return { id: deleted.id, object: "attribute_mapping" as const, deleted: true as const }
					}),
				)
		}),
)
