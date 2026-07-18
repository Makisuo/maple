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
	LIST_LIMIT_DEFAULT,
	conflict,
	dependencyUnavailable,
	invalidRequest,
	paginateArray,
	resourceNotFound,
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
import { Clock, Effect, Match, Schema } from "effect"
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

const toInternalTimeRange = (
	range: NonNullable<V2DashboardCreateParams["timeRange"]>,
): PortableDashboardDocument["timeRange"] =>
	range.type === "relative"
		? range
		: {
				type: "absolute",
				startTime: asIsoDateTime(range.startTime),
				endTime: asIsoDateTime(range.endTime),
			}

const toPortable = (payload: V2DashboardCreateParams): PortableDashboardDocument =>
	new PortableDashboardDocument({
		name: payload.name,
		...(payload.description !== undefined && payload.description !== null
			? { description: payload.description }
			: {}),
		...(payload.tags !== undefined ? { tags: payload.tags } : {}),
		timeRange:
			payload.timeRange === undefined
				? { type: "relative", value: "12h" }
				: toInternalTimeRange(payload.timeRange),
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
		timeRange:
			payload.timeRange === undefined ? current.timeRange : toInternalTimeRange(payload.timeRange),
		widgets: payload.widgets ?? current.widgets,
		...(variables !== undefined ? { variables } : {}),
		createdAt: current.createdAt,
		updatedAt,
	})
}

const mapPersistenceError = () => dependencyUnavailable("dashboard_list_unavailable")

const mapReadError = (error: DashboardNotFoundError | DashboardPersistenceError) =>
	error instanceof DashboardNotFoundError
		? resourceNotFound("dashboard", "No such dashboard.")
		: dependencyUnavailable("dashboard_retrieve_unavailable")

const mapWriteError =
	(operation: string) =>
	(error: DashboardValidationError | DashboardPersistenceError | DashboardConcurrencyError) =>
		Match.value(error).pipe(
			Match.tagsExhaustive({
				"@maple/http/errors/DashboardValidationError": (validation) =>
					invalidRequest("parameter_invalid", validation.message),
				"@maple/http/errors/DashboardConcurrencyError": (concurrency) =>
					conflict("dashboard_concurrent_update", concurrency.message),
				"@maple/http/errors/DashboardPersistenceError": () =>
					dependencyUnavailable(`dashboard_${operation}_unavailable`),
			}),
		)

const mapUpdateError =
	(operation: string) =>
	(
		error:
			| DashboardNotFoundError
			| DashboardValidationError
			| DashboardPersistenceError
			| DashboardConcurrencyError,
	) =>
		error instanceof DashboardNotFoundError
			? resourceNotFound("dashboard", "No such dashboard.")
			: mapWriteError(operation)(error)

const mapVersionError = (
	error: DashboardNotFoundError | DashboardVersionNotFoundError | DashboardPersistenceError,
) =>
	error instanceof DashboardNotFoundError || error instanceof DashboardVersionNotFoundError
		? resourceNotFound(
				error instanceof DashboardVersionNotFoundError ? "dashboard_version" : "dashboard",
				error instanceof DashboardVersionNotFoundError
					? "No such dashboard version."
					: "No such dashboard.",
			)
		: dependencyUnavailable("dashboard_version_retrieve_unavailable")

const mapRestoreError =
	(operation: string) =>
	(
		error:
			| DashboardNotFoundError
			| DashboardVersionNotFoundError
			| DashboardValidationError
			| DashboardPersistenceError
			| DashboardConcurrencyError,
	) =>
		error instanceof DashboardNotFoundError || error instanceof DashboardVersionNotFoundError
			? resourceNotFound(
					error instanceof DashboardVersionNotFoundError ? "dashboard_version" : "dashboard",
					error instanceof DashboardVersionNotFoundError
						? "No such dashboard version."
						: "No such dashboard.",
				)
			: mapWriteError(operation)(error)

const encodeVersionCursor = (versionNumber: number): string => `ver_${versionNumber.toString(36)}`

const decodeVersionCursor = (cursor: string): number | null => {
	const match = /^ver_([0-9a-z]+)$/.exec(cursor)
	if (match === null) return null
	const version = Number.parseInt(match[1]!, 36)
	return Number.isSafeInteger(version) && version > 0 ? version : null
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
					const page = yield* paginateArray(response.dashboards.map(toV2Dashboard), query)
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
						.pipe(Effect.mapError(mapWriteError("create")))
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
						.pipe(Effect.mapError(mapUpdateError("update")))
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
						.pipe(Effect.mapError(mapWriteError("import")))
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
							limit: query.limit ?? LIST_LIMIT_DEFAULT,
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
						.getVersion(tenant.orgId, params.id, params.version_id)
						.pipe(Effect.mapError(mapVersionError))
					return toV2VersionDetail(version)
				}),
			)
			.handle("restoreVersion", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const dashboard = yield* persistence
						.restoreVersion(tenant.orgId, tenant.userId, params.id, params.version_id)
						.pipe(Effect.mapError(mapRestoreError("restore_version")))
					return toV2DashboardMutation(dashboard)
				}),
			)
			.handle("listTemplates", ({ query }) =>
				Effect.map(
					paginateArray(
						listTemplateMetadata().map((template) =>
							toV2Template(new DashboardTemplateMetadata(template)),
						),
						query,
					),
					(page) => ({ object: "list" as const, ...page }),
				),
			)
			.handle("instantiateTemplate", ({ params, payload }) =>
				Effect.gen(function* () {
					const template = getTemplateById(params.template_id)
					if (!template)
						return yield* Effect.fail(
							resourceNotFound(
								"dashboard_template",
								"No such dashboard template.",
								"template_id",
							),
						)

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
						.pipe(Effect.mapError(mapWriteError("instantiate_template")))
					return toV2DashboardMutation(dashboard)
				}),
			)
	}),
)
