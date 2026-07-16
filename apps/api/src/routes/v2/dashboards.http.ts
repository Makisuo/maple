import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	CurrentTenant,
	DashboardConcurrencyError,
	DashboardDocument,
	DashboardNotFoundError,
	DashboardPersistenceError,
	DashboardTemplateMetadata,
	DashboardValidationError,
	DashboardVersionNotFoundError,
	IsoDateTimeString,
	PortableDashboardDocument,
} from "@maple/domain/http"
import {
	MapleApiV2,
	conflict,
	invalidRequest,
	notFound,
	paginateArray,
	serviceUnavailable,
} from "@maple/domain/http/v2"
import type {
	V2Dashboard,
	V2DashboardCreateParams,
	V2DashboardMutation,
	V2DashboardTemplate,
	V2DashboardUpdateParams,
	V2DashboardVersion,
	V2DashboardVersionDetail,
} from "@maple/domain/http/v2"
import { Clock, Effect, Schema } from "effect"
import { getTemplateById, listTemplateMetadata } from "../../dashboard-templates"
import type { TemplateParameterValues } from "../../dashboard-templates"
import { DashboardPersistenceService } from "../../services/DashboardPersistenceService"
import { convertPersesDashboardToPortable } from "../../services/perses-dashboard-import"

const toV2Dashboard = (dashboard: DashboardDocument): V2Dashboard => ({
	id: dashboard.id,
	object: "dashboard",
	name: dashboard.name,
	description: dashboard.description ?? null,
	tags: dashboard.tags ?? [],
	timeRange: dashboard.timeRange,
	widgets: dashboard.widgets,
	variables: dashboard.variables ?? [],
	createdAt: dashboard.createdAt,
	updatedAt: dashboard.updatedAt,
})

const toV2DashboardMutation = (dashboard: DashboardDocument): V2DashboardMutation => ({
	...toV2Dashboard(dashboard),
	...(dashboard.txid !== undefined ? { txid: dashboard.txid } : {}),
})

const toV2Version = (version: {
	readonly id: V2DashboardVersion["id"]
	readonly dashboardId: V2DashboardVersion["dashboardId"]
	readonly versionNumber: number
	readonly changeKind: V2DashboardVersion["changeKind"]
	readonly changeSummary: string | null
	readonly sourceVersionId: V2DashboardVersion["sourceVersionId"]
	readonly createdAt: V2DashboardVersion["createdAt"]
	readonly createdBy: V2DashboardVersion["createdBy"]
}): V2DashboardVersion => ({
	...version,
	object: "dashboard_version",
})

const toV2VersionDetail = (
	version: Parameters<typeof toV2Version>[0] & {
		readonly snapshot: DashboardDocument
	},
): V2DashboardVersionDetail => ({
	...toV2Version(version),
	snapshot: toV2Dashboard(version.snapshot),
})

const toV2Template = (template: DashboardTemplateMetadata): V2DashboardTemplate => ({
	...template,
	object: "dashboard_template",
})

const asIsoDateTime = Schema.decodeUnknownSync(IsoDateTimeString)

const toPortable = (payload: V2DashboardCreateParams): PortableDashboardDocument =>
	new PortableDashboardDocument({
		name: payload.name,
		...(payload.description !== undefined && payload.description !== null
			? { description: payload.description }
			: {}),
		...(payload.tags !== undefined ? { tags: payload.tags } : {}),
		timeRange: payload.timeRange ?? { type: "relative", value: "12h" },
		widgets: payload.widgets ?? [],
		...(payload.variables !== undefined ? { variables: payload.variables } : {}),
	})

const applyUpdate = (
	current: DashboardDocument,
	payload: V2DashboardUpdateParams,
	updatedAt: IsoDateTimeString,
): DashboardDocument => {
	const description =
		payload.description === undefined ? current.description : (payload.description ?? undefined)
	const tags = payload.tags === undefined ? current.tags : payload.tags
	const variables = payload.variables === undefined ? current.variables : payload.variables

	return new DashboardDocument({
		id: current.id,
		name: payload.name ?? current.name,
		...(description !== undefined ? { description } : {}),
		...(tags !== undefined ? { tags } : {}),
		timeRange: payload.timeRange ?? current.timeRange,
		widgets: payload.widgets ?? current.widgets,
		...(variables !== undefined ? { variables } : {}),
		createdAt: current.createdAt,
		updatedAt,
	})
}

const mapPersistenceError = (error: DashboardPersistenceError) => serviceUnavailable(error.message)

const mapReadError = (error: DashboardNotFoundError | DashboardPersistenceError) =>
	error instanceof DashboardNotFoundError
		? notFound(error.message, "id")
		: serviceUnavailable(error.message)

const mapWriteError = (
	error: DashboardValidationError | DashboardPersistenceError | DashboardConcurrencyError,
) => {
	switch (error._tag) {
		case "@maple/http/errors/DashboardValidationError":
			return invalidRequest("parameter_invalid", error.message)
		case "@maple/http/errors/DashboardConcurrencyError":
			return conflict("resource_conflict", error.message)
		default:
			return serviceUnavailable(error.message)
	}
}

const mapUpdateError = (
	error:
		| DashboardNotFoundError
		| DashboardValidationError
		| DashboardPersistenceError
		| DashboardConcurrencyError,
) => (error instanceof DashboardNotFoundError ? notFound(error.message, "id") : mapWriteError(error))

const mapVersionError = (
	error: DashboardNotFoundError | DashboardVersionNotFoundError | DashboardPersistenceError,
) =>
	error instanceof DashboardNotFoundError || error instanceof DashboardVersionNotFoundError
		? notFound(error.message, "id")
		: serviceUnavailable(error.message)

const mapRestoreError = (
	error:
		| DashboardNotFoundError
		| DashboardVersionNotFoundError
		| DashboardValidationError
		| DashboardPersistenceError
		| DashboardConcurrencyError,
) =>
	error instanceof DashboardNotFoundError || error instanceof DashboardVersionNotFoundError
		? notFound(error.message, "id")
		: mapWriteError(error)

const encodeVersionCursor = (versionNumber: number): string => `ver_${versionNumber.toString(36)}`

const decodeVersionCursor = (cursor: string): number | null => {
	if (!cursor.startsWith("ver_")) return null
	const version = Number.parseInt(cursor.slice(4), 36)
	return Number.isInteger(version) && version > 0 ? version : null
}

export const HttpV2DashboardsLive = HttpApiBuilder.group(MapleApiV2, "dashboards", (handlers) =>
	Effect.gen(function* () {
		const persistence = yield* DashboardPersistenceService

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const response = yield* persistence
						.list(tenant.orgId)
						.pipe(Effect.mapError(mapPersistenceError))
					const page = paginateArray(response.dashboards.map(toV2Dashboard), query)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const dashboard = yield* persistence
						.get(tenant.orgId, params.id)
						.pipe(Effect.mapError(mapReadError))
					return toV2Dashboard(dashboard)
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const dashboard = yield* persistence
						.create(tenant.orgId, tenant.userId, toPortable(payload))
						.pipe(Effect.mapError(mapWriteError))
					return toV2DashboardMutation(dashboard)
				}),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const updatedAt = asIsoDateTime(new Date(yield* Clock.currentTimeMillis).toISOString())
					const dashboard = yield* persistence
						.mutate(tenant.orgId, tenant.userId, params.id, (current) =>
							Effect.succeed(applyUpdate(current, payload, updatedAt)),
						)
						.pipe(Effect.mapError(mapUpdateError))
					return toV2DashboardMutation(dashboard)
				}),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const deleted = yield* persistence
						.delete(tenant.orgId, params.id)
						.pipe(Effect.mapError(mapReadError))
					return {
						id: deleted.id,
						object: "dashboard" as const,
						deleted: true as const,
						...(deleted.txid !== undefined ? { txid: deleted.txid } : {}),
					}
				}),
			)
			.handle("importPerses", ({ payload }) =>
				Effect.gen(function* () {
					const converted = yield* convertPersesDashboardToPortable(payload.dashboard).pipe(
						Effect.mapError((error) => invalidRequest("parameter_invalid", error.message)),
					)
					const tenant = yield* CurrentTenant.Context
					const dashboard = yield* persistence
						.create(tenant.orgId, tenant.userId, converted.dashboard)
						.pipe(Effect.mapError(mapWriteError))
					return {
						object: "dashboard_import" as const,
						dashboard: toV2DashboardMutation(dashboard),
						warnings: [...converted.warnings],
					}
				}),
			)
			.handle("listVersions", ({ params, query }) =>
				Effect.gen(function* () {
					const before = query.cursor === undefined ? undefined : decodeVersionCursor(query.cursor)
					if (query.cursor !== undefined && before === null) {
						return yield* Effect.fail(
							invalidRequest("parameter_invalid", "Invalid dashboard version cursor", "cursor"),
						)
					}
					const tenant = yield* CurrentTenant.Context
					const response = yield* persistence
						.listVersions(tenant.orgId, params.id, {
							limit: query.limit,
							...(before !== undefined && before !== null ? { before } : {}),
						})
						.pipe(Effect.mapError(mapReadError))
					const data = response.versions.map(toV2Version)
					return {
						object: "list" as const,
						data,
						has_more: response.hasMore,
						next_cursor:
							response.hasMore && data.length > 0
								? encodeVersionCursor(data[data.length - 1]!.versionNumber)
								: null,
					}
				}),
			)
			.handle("retrieveVersion", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const version = yield* persistence
						.getVersion(tenant.orgId, params.id, params.versionId)
						.pipe(Effect.mapError(mapVersionError))
					return toV2VersionDetail(version)
				}),
			)
			.handle("restoreVersion", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const dashboard = yield* persistence
						.restoreVersion(tenant.orgId, tenant.userId, params.id, params.versionId)
						.pipe(Effect.mapError(mapRestoreError))
					return toV2DashboardMutation(dashboard)
				}),
			)
			.handle("listTemplates", ({ query }) => {
				const page = paginateArray(
					listTemplateMetadata().map((template) =>
						toV2Template(new DashboardTemplateMetadata(template)),
					),
					query,
				)
				return Effect.succeed({ object: "list" as const, ...page })
			})
			.handle("instantiateTemplate", ({ params, payload }) =>
				Effect.gen(function* () {
					const template = getTemplateById(params.templateId)
					if (!template)
						return yield* Effect.fail(notFound("Dashboard template not found", "template_id"))

					const provided: TemplateParameterValues = payload.parameters ?? {}
					const missing = template.parameters
						.filter((parameter) => parameter.required && !provided[parameter.key])
						.map((parameter) => parameter.key)
					if (missing.length > 0) {
						return yield* Effect.fail(
							invalidRequest(
								"parameter_missing",
								`Missing required template parameters: ${missing.join(", ")}`,
								"parameters",
							),
						)
					}

					const built = yield* Effect.try({
						try: () => template.build(provided),
						catch: (error) =>
							invalidRequest(
								"parameter_invalid",
								error instanceof Error ? error.message : "Template build failed",
								"parameters",
							),
					})

					const portable = new PortableDashboardDocument({
						name: payload.name ?? built.name,
						...(built.description !== undefined ? { description: built.description } : {}),
						...(built.tags !== undefined ? { tags: built.tags } : {}),
						timeRange: built.timeRange,
						widgets: built.widgets,
					})
					const tenant = yield* CurrentTenant.Context
					const dashboard = yield* persistence
						.create(tenant.orgId, tenant.userId, portable)
						.pipe(Effect.mapError(mapWriteError))
					return toV2DashboardMutation(dashboard)
				}),
			)
	}),
)
