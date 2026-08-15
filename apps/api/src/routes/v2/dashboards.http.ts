import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	CurrentTenant,
	DashboardDocument,
	DashboardTemplateMetadata,
	DashboardTemplateNotFoundError,
	IsoDateTimeString,
	ShareWidgetNotFoundError,
	PortableDashboardDocument,
} from "@maple/domain/http"
import {
	MapleApiV2,
	LIST_LIMIT_DEFAULT,
	paginateArray,
	V2ParameterInvalid,
	V2ParameterMissing,
} from "@maple/domain/http/v2"
import type {
	V2Dashboard,
	V2DashboardCreateParams,
	V2DashboardMutation,
	V2DashboardShare,
	V2DashboardTemplate,
	V2DashboardUpdateParams,
	V2DashboardVersion,
	V2DashboardVersionDetail,
} from "@maple/domain/http/v2"
import type { DashboardShare, DashboardShareMode } from "@maple/domain/http"
import type { DashboardId } from "@maple/domain/primitives"
import { Clock, Effect, Option, Schema } from "effect"
import { getTemplateById, listTemplateMetadata } from "@/dashboard-templates"
import type { TemplateParameterValues } from "@/dashboard-templates"
import { DashboardPersistenceService } from "@/services/dashboards/DashboardPersistenceService"
import { SharedDashboardService } from "@/services/dashboards/SharedDashboardService"
import { convertPersesDashboardToPortable } from "@/services/dashboards/perses-dashboard-import"

const toV2Dashboard = (dashboard: DashboardDocument): V2Dashboard => ({
	id: dashboard.id,
	object: "dashboard",
	name: dashboard.name,
	description: dashboard.description ?? null,
	tags: dashboard.tags ?? [],
	timeRange: dashboard.timeRange,
	widgets: dashboard.widgets,
	sections: dashboard.sections ?? [],
	variables: dashboard.variables ?? [],
	refreshIntervalSeconds: dashboard.refreshIntervalSeconds ?? null,
	createdAt: dashboard.createdAt,
	updatedAt: dashboard.updatedAt,
})

const toV2DashboardShare = (share: DashboardShare): V2DashboardShare => ({
	id: share.id,
	object: "dashboard_share",
	dashboardId: share.dashboardId,
	...(share.widgetId === undefined ? undefined : { widgetId: share.widgetId }),
	mode: share.mode,
	token: share.token,
	tokenSuffix: share.tokenSuffix,
	createdAt: share.createdAt,
	updatedAt: share.updatedAt,
})

const toV2DashboardMutation = (dashboard: DashboardDocument): V2DashboardMutation => ({
	...toV2Dashboard(dashboard),
	...(dashboard.txid !== undefined ? { txid: dashboard.txid } : undefined),
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

/**
 * A widget may pin its own window; its ISO strings need the same branding the
 * dashboard-level range gets. Destructured rather than spread-and-overwrite so
 * an unpinned widget arrives without the `optionalKey` at all.
 */
const toInternalWidgets = (
	widgets: NonNullable<V2DashboardCreateParams["widgets"]>,
): DashboardDocument["widgets"] =>
	widgets.map((widget) => {
		const { timeRange, ...rest } = widget
		return timeRange ? { ...rest, timeRange: toInternalTimeRange(timeRange) } : rest
	})

const toPortable = (payload: V2DashboardCreateParams): PortableDashboardDocument =>
	new PortableDashboardDocument({
		name: payload.name,
		...(payload.description !== undefined && payload.description !== null
			? { description: payload.description }
			: undefined),
		...(payload.tags !== undefined ? { tags: payload.tags } : undefined),
		timeRange:
			payload.timeRange === undefined
				? { type: "relative", value: "12h" }
				: toInternalTimeRange(payload.timeRange),
		widgets: toInternalWidgets(payload.widgets ?? []),
		...(payload.sections !== undefined ? { sections: payload.sections } : undefined),
		...(payload.variables !== undefined ? { variables: payload.variables } : undefined),
		...(payload.refreshIntervalSeconds !== undefined && payload.refreshIntervalSeconds !== null
			? {
					refreshIntervalSeconds: payload.refreshIntervalSeconds,
				}
			: undefined),
	})

const applyUpdate = (
	current: DashboardDocument,
	payload: V2DashboardUpdateParams,
	updatedAt: IsoDateTimeString,
): DashboardDocument => {
	const description =
		payload.description === undefined ? current.description : (payload.description ?? undefined)
	const tags = payload.tags === undefined ? current.tags : payload.tags
	const sections = payload.sections === undefined ? current.sections : payload.sections
	const variables = payload.variables === undefined ? current.variables : payload.variables
	// `null` clears the cadence (off); an omitted key retains it — same contract as
	// `description`.
	const refreshIntervalSeconds =
		payload.refreshIntervalSeconds === undefined
			? current.refreshIntervalSeconds
			: (payload.refreshIntervalSeconds ?? undefined)

	return new DashboardDocument({
		id: current.id,
		name: payload.name ?? current.name,
		...(description !== undefined ? { description } : undefined),
		...(tags !== undefined ? { tags } : undefined),
		timeRange:
			payload.timeRange === undefined ? current.timeRange : toInternalTimeRange(payload.timeRange),
		widgets: payload.widgets ? toInternalWidgets(payload.widgets) : current.widgets,
		...(sections !== undefined ? { sections } : undefined),
		...(variables !== undefined ? { variables } : undefined),
		...(refreshIntervalSeconds !== undefined ? { refreshIntervalSeconds } : undefined),
		createdAt: current.createdAt,
		updatedAt,
	})
}

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
		const shares = yield* SharedDashboardService

		// Share management.
		//
		// A share is scoped to a whole dashboard (`widgetId` null) or to one widget.
		// The two are independent links with their own tokens, modes and revocation,
		// so a public chart embed survives its board being flipped to org-only or
		// unshared entirely. That independence is a property of the rows, not of the
		// code paths: the two sets of endpoints differ only in the scope they pass,
		// so they run the same four operations rather than a parallel copy of each
		// that could drift.
		const openScope = Effect.fn("dashboards.openShareScope")(function* (
			dashboardId: DashboardId,
			widgetId: string | null,
		) {
			// Loading the dashboard is the check every share operation needs first:
			// one aimed at a board belonging to another org — or to no one — fails as
			// `DashboardNotFoundError` before it can touch a share row. The share
			// table's own queries are org-scoped too, so this is the outer of two
			// checks, not the only one.
			const tenant = yield* CurrentTenant.Context
			const dashboard = yield* persistence.get(tenant.orgId, dashboardId)
			return { tenant, dashboard, scope: { dashboardId, widgetId } }
		})

		/**
		 * One log line per share mutation, with the scope in the annotations rather
		 * than in the message — so "every share event for this dashboard" is one
		 * query whether the link was board-wide or per-widget.
		 */
		const logShare = (
			event: string,
			context: Effect.Success<ReturnType<typeof openScope>>,
			fields: Record<string, unknown>,
		) =>
			Effect.logInfo(event).pipe(
				// Keys match the span attributes the share service sets, so a log and
				// a span for the same event join on the same names rather than needing
				// two vocabularies.
				Effect.annotateLogs({
					orgId: context.tenant.orgId,
					"tenant.userId": context.tenant.userId,
					"maple.dashboard.id": context.scope.dashboardId,
					...(context.scope.widgetId === null ? {} : { "maple.widget.id": context.scope.widgetId }),
					...fields,
				}),
			)

		const retrieveShare = (dashboardId: DashboardId, widgetId: string | null) =>
			Effect.gen(function* () {
				const context = yield* openScope(dashboardId, widgetId)
				const share = yield* shares.get(context.tenant.orgId, context.scope)

				return Option.match(share, { onNone: () => null, onSome: toV2DashboardShare })
			})

		/**
		 * Takes the opened scope rather than an id, so the widget-scoped caller can
		 * run its existence check on the already-loaded dashboard first. Keeping
		 * that check out here is also what keeps `ShareWidgetNotFoundError` off the
		 * board-wide endpoint's error channel, where it could never occur.
		 */
		const upsertShareIn = (
			context: Effect.Success<ReturnType<typeof openScope>>,
			mode: DashboardShareMode,
		) =>
			Effect.gen(function* () {
				const created = yield* shares.upsert(
					context.tenant.orgId,
					context.tenant.userId,
					context.scope,
					mode,
				)

				yield* logShare("dashboard share upserted", context, {
					"maple.share.id": created.id,
					mode: created.mode,
				})

				return toV2DashboardShare(created)
			})

		const rotateShare = (dashboardId: DashboardId, widgetId: string | null) =>
			Effect.gen(function* () {
				const context = yield* openScope(dashboardId, widgetId)
				const rotated = yield* shares.rotate(
					context.tenant.orgId,
					context.tenant.userId,
					context.scope,
				)

				yield* logShare("dashboard share rotated", context, { "maple.share.id": rotated.id })

				return toV2DashboardShare(rotated)
			})

		const revokeShare = (dashboardId: DashboardId, widgetId: string | null) =>
			Effect.gen(function* () {
				const context = yield* openScope(dashboardId, widgetId)
				const tombstone = yield* shares.revoke(
					context.tenant.orgId,
					context.tenant.userId,
					context.scope,
				)

				yield* logShare("dashboard share revoked", context, { hadLiveShare: tombstone.revoked })

				// `deleted: true` regardless of whether a live share existed: "stop
				// sharing" is a statement about the end state, and the dialog must be
				// able to call it without checking first.
				return {
					dashboardId,
					object: "dashboard_share" as const,
					deleted: true as const,
				}
			})

		return (
			handlers
				.handle("list", ({ query }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const response = yield* persistence.list(tenant.orgId)

						const page = yield* paginateArray(response.dashboards.map(toV2Dashboard), query)
						return { object: "list" as const, ...page }
					}),
				)
				.handle("retrieve", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const dashboard = yield* persistence.get(tenant.orgId, params.id)

						return toV2Dashboard(dashboard)
					}),
				)
				.handle("create", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const dashboard = yield* persistence.create(
							tenant.orgId,
							tenant.userId,
							toPortable(payload),
						)

						return toV2DashboardMutation(dashboard)
					}),
				)
				.handle("update", ({ params, payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const updatedAt = asIsoDateTime(
							new Date(yield* Clock.currentTimeMillis).toISOString(),
						)
						const dashboard = yield* persistence.mutate(
							tenant.orgId,
							tenant.userId,
							params.id,
							(current) => Effect.succeed(applyUpdate(current, payload, updatedAt)),
						)

						return toV2DashboardMutation(dashboard)
					}),
				)
				.handle("delete", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const deleted = yield* persistence.delete(tenant.orgId, params.id)

						return {
							id: deleted.id,
							object: "dashboard" as const,
							deleted: true as const,
							...(deleted.txid !== undefined ? { txid: deleted.txid } : undefined),
						}
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

						return {
							object: "dashboard_import" as const,
							dashboard: toV2DashboardMutation(dashboard),
							warnings: [...converted.warnings],
						}
					}),
				)
				.handle("listVersions", ({ params, query }) =>
					Effect.gen(function* () {
						const before =
							query.cursor === undefined ? undefined : decodeVersionCursor(query.cursor)
						if (query.cursor !== undefined && before === null) {
							return yield* Effect.fail(
								V2ParameterInvalid.make("Invalid dashboard version cursor", {
									param: "cursor",
								}),
							)
						}
						const tenant = yield* CurrentTenant.Context
						const response = yield* persistence.listVersions(tenant.orgId, params.id, {
							limit: query.limit ?? LIST_LIMIT_DEFAULT,
							...(before !== undefined && before !== null ? { before } : undefined),
						})

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
						const version = yield* persistence.getVersion(
							tenant.orgId,
							params.id,
							params.version_id,
						)

						return toV2VersionDetail(version)
					}),
				)
				.handle("restoreVersion", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const dashboard = yield* persistence.restoreVersion(
							tenant.orgId,
							tenant.userId,
							params.id,
							params.version_id,
						)

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
				// Read-only sibling of `instantiateTemplate`: same pure build, nothing
				// persisted. Unlike instantiate it does not enforce required
				// parameters — the picker previews a template before you have filled
				// them in, and showing the dashboard you would get is the whole point.
				.handle("previewTemplate", ({ params, payload }) =>
					Effect.gen(function* () {
						const template = getTemplateById(params.template_id)
						if (!template)
							return yield* Effect.fail(
								new DashboardTemplateNotFoundError({
									templateId: params.template_id,
									message: "No such dashboard template.",
								}),
							)

						const built = yield* Effect.try({
							try: () => template.build(payload.parameters ?? {}),
							catch: (error) =>
								V2ParameterInvalid.make(
									error instanceof Error ? error.message : "Template build failed",
									{ param: "parameters" },
								),
						})

						return {
							object: "dashboard_template_preview" as const,
							name: built.name,
							timeRange: built.timeRange,
							widgets: built.widgets,
							variables: built.variables ?? [],
						}
					}),
				)
				.handle("instantiateTemplate", ({ params, payload }) =>
					Effect.gen(function* () {
						const template = getTemplateById(params.template_id)
						if (!template)
							return yield* Effect.fail(
								new DashboardTemplateNotFoundError({
									templateId: params.template_id,
									message: "No such dashboard template.",
								}),
							)

						const provided: TemplateParameterValues = payload.parameters ?? {}
						const missing = template.parameters
							.filter((parameter) => parameter.required && !provided[parameter.key])
							.map((parameter) => parameter.key)
						if (missing.length > 0) {
							return yield* Effect.fail(
								V2ParameterMissing.make(
									`Missing required template parameters: ${missing.join(", ")}`,
									{ param: "parameters" },
								),
							)
						}

						const built = yield* Effect.try({
							try: () => template.build(provided),
							catch: (error) =>
								V2ParameterInvalid.make(
									error instanceof Error ? error.message : "Template build failed",
									{ param: "parameters" },
								),
						})

						const portable = new PortableDashboardDocument({
							name: payload.name ?? built.name,
							...(built.description !== undefined
								? { description: built.description }
								: undefined),
							...(built.tags !== undefined ? { tags: built.tags } : undefined),
							timeRange: built.timeRange,
							widgets: built.widgets,
						})
						const tenant = yield* CurrentTenant.Context
						const dashboard = yield* persistence.create(tenant.orgId, tenant.userId, portable)

						return toV2DashboardMutation(dashboard)
					}),
				)
				// Share management. Every operation is `<verb>Share(id, widgetId)` —
				// see the helpers above the handler chain.
				.handle("listShares", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* persistence.get(tenant.orgId, params.id)
						const live = yield* shares.listForDashboard(tenant.orgId, params.id)

						return live.map(toV2DashboardShare)
					}),
				)
				.handle("retrieveShare", ({ params }) => retrieveShare(params.id, null))
				.handle("upsertShare", ({ params, payload }) =>
					openScope(params.id, null).pipe(
						Effect.flatMap((context) => upsertShareIn(context, payload.mode)),
					),
				)
				.handle("rotateShare", ({ params }) => rotateShare(params.id, null))
				.handle("revokeShare", ({ params }) => revokeShare(params.id, null))
				.handle("retrieveWidgetShare", ({ params }) => retrieveShare(params.id, params.widget_id))
				.handle("upsertWidgetShare", ({ params, payload }) =>
					Effect.gen(function* () {
						const context = yield* openScope(params.id, params.widget_id)

						// Minting a link for a widget that does not exist would produce a
						// token that resolves to a permanently blank tile, so the widget is
						// checked here rather than at first view.
						if (!context.dashboard.widgets.some((w) => w.id === params.widget_id)) {
							return yield* Effect.fail(
								new ShareWidgetNotFoundError({
									message: "That widget is not on this dashboard.",
									widgetId: params.widget_id,
								}),
							)
						}

						return yield* upsertShareIn(context, payload.mode)
					}),
				)
				.handle("rotateWidgetShare", ({ params }) => rotateShare(params.id, params.widget_id))
				.handle("revokeWidgetShare", ({ params }) => revokeShare(params.id, params.widget_id))
		)
	}),
)
