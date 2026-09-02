import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { IngestAttributeMapping, IngestAttributeMappingId, OrgId } from "@maple/domain/http"
import {
	CreateIngestAttributeMappingRequest,
	CurrentTenant,
	IngestAttributeMappingForbiddenError,
	IngestAttributeMappingNotFoundError,
	UpdateIngestAttributeMappingRequest,
} from "@maple/domain/http"
import { MapleApiV2, paginateArray } from "@maple/domain/http/v2"
import type { V2AttributeMapping } from "@maple/domain/http/v2"
import { Array as Arr, Effect, Option } from "effect"
import { requireAdmin } from "@/services/auth/auth"
import { diffAuditChanges, pickPresentFields } from "@/routes/v2/audit-changes"
import { recordHttpAudit } from "@/services/audit/AuditLogService"
import { IngestAttributeMappingService } from "@/services/org/IngestAttributeMappingService"

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

/** Update-payload fields that are diffable through the wire shape. */
const mappingAuditKeys: ReadonlyArray<
	"name" | "source_context" | "source_key" | "target_key" | "operation" | "enabled"
> = ["name", "source_context", "source_key", "target_key", "operation", "enabled"]

export const HttpV2AttributeMappingsLive = HttpApiBuilder.group(MapleApiV2, "attributeMappings", (handlers) =>
	Effect.gen(function* () {
		const service = yield* IngestAttributeMappingService

		// A mapping rewrites every ingested span for the whole org, so the writes
		// are admin-only; the reads stay open to any member.
		const requireMappingAdmin = (tenant: CurrentTenant.TenantSchema, action: string) =>
			requireAdmin(
				tenant.roles,
				() =>
					new IngestAttributeMappingForbiddenError({
						message: `Only org admins can ${action} attribute mappings`,
						...(tenant.roles.length > 0 ? { roles: [...tenant.roles] } : undefined),
					}),
			)

		const listMappings = (orgId: OrgId) => service.list(orgId)

		const findMapping = (orgId: OrgId, id: IngestAttributeMappingId) =>
			listMappings(orgId).pipe(
				Effect.flatMap((response) =>
					Option.match(
						Arr.findFirst(response.mappings, (candidate) => candidate.id === id),
						{
							onNone: () =>
								Effect.fail(
									new IngestAttributeMappingNotFoundError({
										mappingId: id,
										message: "No such attribute mapping.",
									}),
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
					yield* requireMappingAdmin(tenant, "create")
					const created = yield* service.create(
						tenant.orgId,
						new CreateIngestAttributeMappingRequest({
							name: payload.name,
							sourceContext: payload.source_context,
							sourceKey: payload.source_key,
							targetKey: payload.target_key,
							operation: payload.operation,
							...(payload.enabled !== undefined ? { enabled: payload.enabled } : undefined),
						}),
					)

					yield* recordHttpAudit("attribute_mapping.created", {
						resourceId: created.id,
						metadata: { name: created.name },
					})

					return toV2AttributeMapping(created)
				}),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireMappingAdmin(tenant, "update")
					const current = yield* findMapping(tenant.orgId, params.id)
					const updated = yield* service.update(
						tenant.orgId,
						params.id,
						new UpdateIngestAttributeMappingRequest({
							...(payload.name !== undefined ? { name: payload.name } : undefined),
							...(payload.source_context !== undefined
								? {
										sourceContext: payload.source_context,
									}
								: undefined),
							...(payload.source_key !== undefined
								? { sourceKey: payload.source_key }
								: undefined),
							...(payload.target_key !== undefined
								? { targetKey: payload.target_key }
								: undefined),
							...(payload.operation !== undefined
								? { operation: payload.operation }
								: undefined),
							...(payload.enabled !== undefined ? { enabled: payload.enabled } : undefined),
						}),
					)

					const changes = diffAuditChanges(
						pickPresentFields(mappingAuditKeys, payload, toV2AttributeMapping(current)),
						pickPresentFields(mappingAuditKeys, payload, toV2AttributeMapping(updated)),
					)
					yield* recordHttpAudit("attribute_mapping.updated", {
						resourceId: updated.id,
						changes,
						metadata: { name: updated.name },
					})

					return toV2AttributeMapping(updated)
				}),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireMappingAdmin(tenant, "delete")
					const deleted = yield* service.delete(tenant.orgId, params.id)
					yield* recordHttpAudit("attribute_mapping.deleted", {
						resourceId: deleted.id,
					})

					return { id: deleted.id, object: "attribute_mapping" as const, deleted: true as const }
				}),
			)
	}),
)
