import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	CurrentTenant,
	DashboardTemplateMetadata,
	DashboardTemplateNotFoundError,
	DashboardTemplatesListResponse,
	DashboardValidationError,
	DashboardPersesImportResponse,
	MapleApi,
	PortableDashboardDocument,
} from "@maple/domain/http"
import { Effect } from "effect"
import { DashboardPersistenceService } from "../services/DashboardPersistenceService"
import { getTemplateById, listTemplateMetadata } from "../dashboard-templates"
import type { TemplateParameterValues } from "../dashboard-templates"
import { convertPersesDashboardToPortable } from "../services/perses-dashboard-import"

export const HttpDashboardsLive = HttpApiBuilder.group(MapleApi, "dashboards", (handlers) =>
	Effect.gen(function* () {
		const persistence = yield* DashboardPersistenceService

		return handlers
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* persistence.create(tenant.orgId, tenant.userId, payload.dashboard)
				}),
			)
			.handle("list", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* persistence.list(tenant.orgId)
				}),
			)
			.handle("importPerses", ({ payload }) =>
				Effect.gen(function* () {
					const converted = yield* convertPersesDashboardToPortable(payload.dashboard)
					const tenant = yield* CurrentTenant.Context
					const dashboard = yield* persistence.create(
						tenant.orgId,
						tenant.userId,
						converted.dashboard,
					)

					return new DashboardPersesImportResponse({
						dashboard,
						warnings: [...converted.warnings],
					})
				}),
			)
			.handle("upsert", ({ params, payload }) =>
				Effect.gen(function* () {
					if (params.dashboardId !== payload.dashboard.id) {
						return yield* new DashboardValidationError({
							message: "Dashboard ID mismatch",
							details: ["Path dashboardId must match payload.dashboard.id"],
						})
					}

					const tenant = yield* CurrentTenant.Context
					return yield* persistence.upsert(tenant.orgId, tenant.userId, payload.dashboard)
				}),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* persistence.delete(tenant.orgId, params.dashboardId)
				}),
			)
			.handle("listVersions", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* persistence.listVersions(tenant.orgId, params.dashboardId, {
						limit: query.limit,
						before: query.before,
					})
				}),
			)
			.handle("getVersion", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* persistence.getVersion(tenant.orgId, params.dashboardId, params.versionId)
				}),
			)
			.handle("restoreVersion", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* persistence.restoreVersion(
						tenant.orgId,
						tenant.userId,
						params.dashboardId,
						params.versionId,
					)
				}),
			)
			.handle("listTemplates", () =>
				Effect.sync(
					() =>
						new DashboardTemplatesListResponse({
							templates: listTemplateMetadata().map(
								(t) =>
									new DashboardTemplateMetadata({
										id: t.id,
										name: t.name,
										description: t.description,
										category: t.category,
										tags: t.tags,
										requirements: t.requirements,
										requiredMetricPrefixes: t.requiredMetricPrefixes,
										parameters: t.parameters,
										preview: t.preview,
									}),
							),
						}),
				),
			)
			.handle("instantiateTemplate", ({ params, payload }) =>
				Effect.gen(function* () {
					const template = getTemplateById(params.templateId)
					if (!template) {
						return yield* new DashboardTemplateNotFoundError({
							templateId: params.templateId,
							message: `Template "${params.templateId}" not found`,
						})
					}

					const provided: TemplateParameterValues = payload.parameters ?? {}
					const missing = template.parameters
						.filter((p) => p.required && !provided[p.key])
						.map((p) => p.key)
					if (missing.length > 0) {
						return yield* new DashboardValidationError({
							message: "Missing required template parameters",
							details: missing,
						})
					}

					const built = yield* Effect.try({
						try: () => template.build(provided),
						catch: (error) =>
							new DashboardValidationError({
								message: "Template build failed",
								details: [error instanceof Error ? error.message : String(error)],
							}),
					})

					// `description`/`tags` are `Schema.optionalKey`; the Schema.Class
					// constructor rejects a present `undefined`. A template that defines
					// neither surfaces them as `undefined`, so omit the key in that case.
					const portable = new PortableDashboardDocument({
						name: payload.name ?? built.name,
						...(built.description !== undefined && { description: built.description }),
						...(built.tags !== undefined && { tags: built.tags }),
						timeRange: built.timeRange,
						widgets: built.widgets,
					})

					const tenant = yield* CurrentTenant.Context
					return yield* persistence.create(tenant.orgId, tenant.userId, portable)
				}),
			)
	}),
)
