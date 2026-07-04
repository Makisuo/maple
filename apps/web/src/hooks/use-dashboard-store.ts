import {
	Result,
	useAtom,
	useAtomRefresh,
	useAtomSet,
	useAtomSubscribe,
	useAtomValue,
} from "@/lib/effect-atom"
import { useCallback, useMemo, useRef } from "react"
import { Cause, Exit, Option, Schema } from "effect"
import {
	DashboardConcurrencyError,
	DashboardCreateRequest,
	DashboardDocument,
	DashboardId,
	DashboardPersesImportRequest,
	DashboardUpsertRequest,
	IsoDateTimeString,
	PortableDashboardDocument,
} from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { useLiveQuery } from "@tanstack/react-db"
import { ELECTRIC_SYNC_ENABLED } from "@/lib/collections/config"
import { runMapleApi } from "@/lib/collections/api-runner"
import { documentToDashboard, rowToDashboard } from "@/lib/collections/dashboards"
import { getOrgCollections, useActiveOrgId, useCollectionsGeneration } from "@/lib/collections/org-collections"
import type { PortableDashboard } from "@/components/dashboard-builder/portable-dashboard"
import type {
	Dashboard,
	DashboardVariable,
	DashboardWidget,
	TimeRange,
	VisualizationType,
	WidgetDataSource,
	WidgetDisplayConfig,
} from "@/components/dashboard-builder/types"
import { dashboardsAtom, persistenceErrorAtom } from "@/atoms/dashboard-store-atoms"

const GRID_COLS = 12
const asDashboardId = Schema.decodeUnknownSync(DashboardId)
const asIsoDateTimeString = Schema.decodeUnknownSync(IsoDateTimeString)

function generateId() {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function isExitLike(value: unknown): value is Exit.Exit<unknown, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"_tag" in value &&
		((value as { _tag: unknown })._tag === "Success" || (value as { _tag: unknown })._tag === "Failure")
	)
}

function messageFromError(error: unknown): string | null {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message
	}

	if (typeof error === "object" && error !== null) {
		const message = (error as { message?: unknown }).message
		if (typeof message === "string" && message.trim().length > 0) {
			return message
		}
	}

	return null
}

function findNextPosition(widgets: DashboardWidget[], newWidth: number): { x: number; y: number } {
	if (widgets.length === 0) {
		return { x: 0, y: 0 }
	}

	const maxY = Math.max(...widgets.map((w) => w.layout.y))
	const bottomRowWidgets = widgets.filter((w) => w.layout.y === maxY)
	const rightEdge = Math.max(...bottomRowWidgets.map((w) => w.layout.x + w.layout.w))

	if (rightEdge + newWidth <= GRID_COLS) {
		return { x: rightEdge, y: maxY }
	}

	const maxBottom = Math.max(...widgets.map((w) => w.layout.y + w.layout.h))
	return { x: 0, y: maxBottom }
}

function getErrorMessage(error: unknown): string {
	const directMessage = messageFromError(error)
	if (directMessage) return directMessage

	if (isExitLike(error) && Exit.isFailure(error)) {
		const failure = Option.getOrUndefined(Cause.findErrorOption(error.cause))
		const failureMessage = messageFromError(failure)
		if (failureMessage) return failureMessage

		const squashed = Cause.squash(error.cause)
		const squashedMessage = messageFromError(squashed)
		if (squashedMessage) return squashedMessage
	}

	return "Dashboard persistence is temporarily unavailable"
}

// Detect a server-side concurrency rejection. The persistence layer surfaces
// these as the tagged `DashboardConcurrencyError` from `@maple/domain/http`;
// pull the first failure out of the mutation's `Exit` and match on its tag.
function isConcurrencyConflict(failure: Exit.Exit<unknown, unknown>): boolean {
	if (!Exit.isFailure(failure)) return false
	return Option.match(Cause.findErrorOption(failure.cause), {
		onNone: () => false,
		onSome: (error) => error instanceof DashboardConcurrencyError,
	})
}

const decodeDashboardDocument = Schema.decodeUnknownOption(DashboardDocument)

// Validate an unknown payload (a mutation result or list item) against the
// `DashboardDocument` schema. A decoded document is structurally a `Dashboard`
// once its `readonly` arrays are widened to the mutable web equivalents (its
// branded ids / ISO timestamps are already assignable to the web type's strings).
function ensureDashboard(value: unknown): Dashboard | null {
	return Option.match(decodeDashboardDocument(value), {
		onNone: () => null,
		onSome: documentToDashboard,
	})
}

function toDashboardDocument(dashboard: Dashboard): DashboardDocument {
	// `description`/`tags`/`variables` are `Schema.optionalKey` on `DashboardDocument`;
	// the Schema.Class constructor rejects a present `undefined`. The web `Dashboard`
	// carries them as optional and `ensureDashboard` stamps an explicit
	// `tags: undefined`, so destructure them out of the spread and re-add only when set.
	const { description, tags, variables, ...rest } = dashboard
	return new DashboardDocument({
		...rest,
		id: asDashboardId(dashboard.id),
		createdAt: asIsoDateTimeString(dashboard.createdAt),
		updatedAt: asIsoDateTimeString(dashboard.updatedAt),
		...(description !== undefined && { description }),
		...(tags !== undefined && { tags }),
		...(variables !== undefined && { variables }),
		timeRange:
			dashboard.timeRange.type === "absolute"
				? {
						type: "absolute",
						startTime: asIsoDateTimeString(dashboard.timeRange.startTime),
						endTime: asIsoDateTimeString(dashboard.timeRange.endTime),
					}
				: dashboard.timeRange,
	})
}

function toPortableDashboardDocument(dashboard: PortableDashboard): PortableDashboardDocument {
	// See `toDashboardDocument`: omit the optionalKey `description`/`tags`/`variables`
	// rather than forwarding a present `undefined`, which the Schema.Class constructor rejects.
	const { description, tags, variables, ...rest } = dashboard
	return new PortableDashboardDocument({
		...rest,
		...(description !== undefined && { description }),
		...(tags !== undefined && { tags: [...tags] }),
		...(variables !== undefined && { variables: structuredClone(variables) }),
		widgets: structuredClone(dashboard.widgets),
		timeRange:
			dashboard.timeRange.type === "absolute"
				? {
						type: "absolute",
						startTime: asIsoDateTimeString(dashboard.timeRange.startTime),
						endTime: asIsoDateTimeString(dashboard.timeRange.endTime),
					}
				: dashboard.timeRange,
	})
}

function parseDashboards(raw: readonly unknown[]): Dashboard[] {
	return raw.map((d) => ensureDashboard(d)).filter((d): d is Dashboard => d !== null)
}

// Returns the previous array unchanged if every dashboard's id+updatedAt
// matches a previous entry. Preserving identity here breaks the cascade
// where every list-query refetch invalidates every memoised widget render.
//
// Also guards against stale-refetch overwrite: if the local optimistic copy
// has a strictly newer updatedAt than the candidate, the candidate is from a
// list refetch that started before our last mutation landed. Keep the local
// copy; the next post-mutation refetch will settle the state. Without this,
// an optimistic delete can be silently reverted when an in-flight GET
// /api/dashboards lands after our PUT.
function reconcileDashboards(previous: readonly Dashboard[], next: Dashboard[]): Dashboard[] {
	if (previous.length !== next.length) return next

	const previousById = new Map(previous.map((d) => [d.id, d]))
	const reconciled: Dashboard[] = []
	let allMatched = true

	for (const candidate of next) {
		const prior = previousById.get(candidate.id)
		if (prior && prior.updatedAt === candidate.updatedAt) {
			reconciled.push(prior)
		} else if (prior && prior.updatedAt > candidate.updatedAt) {
			reconciled.push(prior)
			allMatched = false
		} else {
			reconciled.push(candidate)
			allMatched = false
		}
	}

	return allMatched ? (previous as Dashboard[]) : reconciled
}

// The dashboard/widget mutators that are byte-for-byte identical between the atom
// and Electric store paths: each is a pure `(Dashboard) => Dashboard` transform
// pushed through the injected `mutateDashboard`. Only the functions that genuinely
// differ between paths (`mutateDashboard`, `create`/`import*`, `delete`) stay in
// the hooks. `readDashboard` supplies the current dashboard for the two mutators
// that read it (atom: from the state ref; Electric: from the collection). The
// updater bodies are path-agnostic, so they survive the eventual atom-path removal.
function makeWidgetMutators(deps: {
	mutateDashboard: (id: string, updater: (dashboard: Dashboard) => Dashboard) => Promise<void>
	readOnly: boolean
	readDashboard: (id: string) => Dashboard | undefined
}) {
	const { mutateDashboard, readOnly, readDashboard } = deps

	const updateDashboard = (
		id: string,
		updates: Partial<Pick<Dashboard, "name" | "description" | "tags">>,
	) => {
		void mutateDashboard(id, (dashboard) => ({
			...dashboard,
			...updates,
			updatedAt: new Date().toISOString(),
		}))
	}

	const updateDashboardTimeRange = (id: string, timeRange: TimeRange) => {
		void mutateDashboard(id, (dashboard) => ({
			...dashboard,
			timeRange,
			updatedAt: new Date().toISOString(),
		}))
	}

	const updateDashboardVariables = (id: string, variables: DashboardVariable[]) => {
		void mutateDashboard(id, (dashboard) => ({
			...dashboard,
			variables,
			updatedAt: new Date().toISOString(),
		}))
	}

	const addWidget = (
		dashboardId: string,
		visualization: VisualizationType,
		dataSource: WidgetDataSource,
		display: WidgetDisplayConfig,
	): DashboardWidget => {
		if (readOnly) {
			throw new Error("Dashboards are read-only")
		}

		const layoutDefaults =
			visualization === "stat"
				? { w: 3, h: 4, minW: 2, minH: 2 }
				: visualization === "table" || visualization === "list"
					? { w: 6, h: 5, minW: 3, minH: 3 }
					: { w: 4, h: 5, minW: 2, minH: 2 }

		// Build the widget synchronously from the current dashboard so we can
		// return it to the caller. `mutateDashboard`'s updater runs asynchronously
		// in the atom path (queued in a promise chain), so a `widgetRef` assigned
		// inside it would still be null at return — the old `widgetRef!` masked a
		// runtime null. `readDashboard` reads the current dashboard in both paths;
		// the grid compactor resolves any position drift between build and apply.
		const position = findNextPosition(readDashboard(dashboardId)?.widgets ?? [], layoutDefaults.w)
		const widget: DashboardWidget = {
			id: generateId(),
			visualization,
			dataSource,
			display,
			layout: { ...position, ...layoutDefaults },
		}

		void mutateDashboard(dashboardId, (dashboard) => ({
			...dashboard,
			widgets: [...dashboard.widgets, widget],
			updatedAt: new Date().toISOString(),
		}))

		return widget
	}

	const cloneWidget = (dashboardId: string, widgetId: string) => {
		if (readOnly) return
		void mutateDashboard(dashboardId, (dashboard) => {
			const source = dashboard.widgets.find((w) => w.id === widgetId)
			if (!source) return dashboard

			const layoutDefaults = {
				w: source.layout.w,
				h: source.layout.h,
				minW: source.layout.minW ?? 2,
				minH: source.layout.minH ?? 2,
			}

			const position = findNextPosition(dashboard.widgets, layoutDefaults.w)
			const clone: DashboardWidget = {
				id: generateId(),
				visualization: source.visualization,
				dataSource: structuredClone(source.dataSource),
				display: structuredClone(source.display),
				layout: { ...position, ...layoutDefaults },
			}

			return {
				...dashboard,
				widgets: [...dashboard.widgets, clone],
				updatedAt: new Date().toISOString(),
			}
		})
	}

	const removeWidget = (dashboardId: string, widgetId: string): DashboardWidget | undefined => {
		// Capture the widget from the current state synchronously so the caller can
		// offer an undo; mutateDashboard runs through a FIFO queue, so snapshotting
		// here matches what the async write will actually delete.
		const removed = readDashboard(dashboardId)?.widgets.find((w) => w.id === widgetId)

		void mutateDashboard(dashboardId, (dashboard) => ({
			...dashboard,
			widgets: dashboard.widgets.filter((widget) => widget.id !== widgetId),
			updatedAt: new Date().toISOString(),
		}))

		return removed
	}

	const restoreWidget = (dashboardId: string, widget: DashboardWidget) => {
		if (readOnly) return
		void mutateDashboard(dashboardId, (dashboard) => {
			// Idempotent: a server refetch may have already reinstated the widget.
			if (dashboard.widgets.some((w) => w.id === widget.id)) return dashboard
			return {
				...dashboard,
				widgets: [...dashboard.widgets, widget],
				updatedAt: new Date().toISOString(),
			}
		})
	}

	const updateWidgetDisplay = (
		dashboardId: string,
		widgetId: string,
		display: Partial<WidgetDisplayConfig>,
	) => {
		void mutateDashboard(dashboardId, (dashboard) => ({
			...dashboard,
			widgets: dashboard.widgets.map((widget) =>
				widget.id === widgetId ? { ...widget, display: { ...widget.display, ...display } } : widget,
			),
			updatedAt: new Date().toISOString(),
		}))
	}

	const updateWidgetLayouts = (
		dashboardId: string,
		layouts: Array<{ i: string; x: number; y: number; w: number; h: number }>,
	) => {
		void mutateDashboard(dashboardId, (dashboard) => {
			let changed = false
			const widgets = dashboard.widgets.map((widget) => {
				const layout = layouts.find((item) => item.i === widget.id)
				if (!layout) return widget
				if (
					widget.layout.x === layout.x &&
					widget.layout.y === layout.y &&
					widget.layout.w === layout.w &&
					widget.layout.h === layout.h
				)
					return widget

				changed = true
				return {
					...widget,
					layout: { ...widget.layout, x: layout.x, y: layout.y, w: layout.w, h: layout.h },
				}
			})

			// Return same reference if nothing changed — mutateDashboard skips no-ops
			if (!changed) return dashboard

			// Sort by (y, x) so the array order matches visual order. The grid
			// compactor uses array order as a tiebreaker when items share a row,
			// so a stale order causes drag-to-swap to snap back.
			const sorted = widgets.toSorted((a, b) => {
				if (a.layout.y !== b.layout.y) return a.layout.y - b.layout.y
				return a.layout.x - b.layout.x
			})

			return { ...dashboard, widgets: sorted, updatedAt: new Date().toISOString() }
		})
	}

	const updateWidget = (
		dashboardId: string,
		widgetId: string,
		updates: Partial<Pick<DashboardWidget, "visualization" | "dataSource" | "display" | "layout">>,
	) => {
		return mutateDashboard(dashboardId, (dashboard) => ({
			...dashboard,
			widgets: dashboard.widgets.map((widget) =>
				widget.id === widgetId ? { ...widget, ...updates } : widget,
			),
			updatedAt: new Date().toISOString(),
		}))
	}

	const autoLayoutWidgets = (dashboardId: string) => {
		void mutateDashboard(dashboardId, (dashboard) => {
			if (dashboard.widgets.length === 0) return dashboard

			const sorted = dashboard.widgets.toSorted((a, b) => {
				if (a.layout.y !== b.layout.y) return a.layout.y - b.layout.y
				return a.layout.x - b.layout.x
			})

			let currentX = 0
			let currentY = 0
			let rowHeight = 0

			const relaid = sorted.map((widget) => {
				const w = widget.layout.w
				const h = widget.layout.h

				if (currentX + w > GRID_COLS) {
					currentX = 0
					currentY += rowHeight
					rowHeight = 0
				}

				const newLayout = { ...widget.layout, x: currentX, y: currentY }
				currentX += w
				rowHeight = Math.max(rowHeight, h)

				return { ...widget, layout: newLayout }
			})

			return { ...dashboard, widgets: relaid, updatedAt: new Date().toISOString() }
		})
	}

	return {
		updateDashboard,
		updateDashboardTimeRange,
		updateDashboardVariables,
		addWidget,
		cloneWidget,
		removeWidget,
		restoreWidget,
		updateWidgetDisplay,
		updateWidgetLayouts,
		updateWidget,
		autoLayoutWidgets,
	}
}

// The original effect-atom implementation (list query + hand-rolled optimistic
// FIFO queue). Remains the default; `useDashboardStore` dispatches here unless
// the ElectricSQL sync path is enabled at build time.
function useDashboardStoreAtoms() {
	const [dashboards, setDashboards] = useAtom(dashboardsAtom)
	const [persistenceError, setPersistenceError] = useAtom(persistenceErrorAtom)

	// Hoist the list query atom so `useAtomRefresh` and `useAtomValue` operate
	// on the same instance — without the memo, each render builds a fresh atom
	// and the refresh handle ends up pointing at a stale, garbage-collected
	// query.
	const listQueryAtom = useMemo(
		() => MapleApiAtomClient.query("dashboards", "list", { reactivityKeys: ["dashboards"] }),
		[],
	)
	const listResult = useAtomValue(listQueryAtom)
	const refetchDashboards = useAtomRefresh(listQueryAtom)
	const createMutation = useAtomSet(MapleApiAtomClient.mutation("dashboards", "create"), {
		mode: "promiseExit",
	})
	const importPersesMutation = useAtomSet(MapleApiAtomClient.mutation("dashboards", "importPerses"), {
		mode: "promiseExit",
	})
	const upsertMutation = useAtomSet(MapleApiAtomClient.mutation("dashboards", "upsert"), {
		mode: "promiseExit",
	})
	const deleteMutation = useAtomSet(MapleApiAtomClient.mutation("dashboards", "delete"), {
		mode: "promiseExit",
	})

	const readOnly = persistenceError !== null

	// Sync server data → local atom. Only apply when listResult actually changes
	// (from a refetch), not on re-mount with the same stale result. Without this guard,
	// navigating between routes re-applies the old listResult and overwrites optimistic updates.
	const lastSyncedListResult = useRef(listResult)
	const syncListResult = useCallback(
		(nextListResult: typeof listResult) => {
			if (nextListResult === lastSyncedListResult.current) return
			lastSyncedListResult.current = nextListResult
			if (Result.isSuccess(nextListResult)) {
				const parsed = parseDashboards(nextListResult.value.dashboards)
				setDashboards((previous) => reconcileDashboards(previous, parsed))
				setPersistenceError(null)
			} else if (Result.isFailure(nextListResult)) {
				setPersistenceError(getErrorMessage(nextListResult))
			}
		},
		[setDashboards, setPersistenceError],
	)
	useAtomSubscribe(listQueryAtom, syncListResult)

	const isLoading = dashboards.length === 0 && !Result.isSuccess(listResult)

	const dashboardsRef = useRef(dashboards)
	dashboardsRef.current = dashboards
	const upsertRef = useRef(upsertMutation)
	upsertRef.current = upsertMutation
	const deleteRef = useRef(deleteMutation)
	deleteRef.current = deleteMutation
	const setDashboardsRef = useRef(setDashboards)
	setDashboardsRef.current = setDashboards
	const setPersistenceErrorRef = useRef(setPersistenceError)
	setPersistenceErrorRef.current = setPersistenceError
	const refetchDashboardsRef = useRef(refetchDashboards)
	refetchDashboardsRef.current = refetchDashboards

	// Per-dashboard FIFO queue. Each mutation chains off the tail so two quick
	// `mutateDashboard` calls against the same id can't race each other —
	// otherwise both would capture the same `dashboardsRef.current` snapshot
	// before the first re-render lands and the second would clobber the first.
	const mutationQueuesRef = useRef<Map<string, Promise<void>>>(new Map())

	const mutateDashboard = useCallback(
		async (dashboardId: string, updater: (dashboard: Dashboard) => Dashboard): Promise<void> => {
			const previousTail = mutationQueuesRef.current.get(dashboardId) ?? Promise.resolve()

			const next = previousTail
				.catch(() => undefined)
				.then(async () => {
					// Capture snapshot AFTER any previous tail's optimistic state
					// has been written back to `dashboardsRef.current` — this is
					// what makes the queue safe for back-to-back edits.
					const snapshot = [...dashboardsRef.current]
					const index = snapshot.findIndex((d) => d.id === dashboardId)
					if (index < 0) return

					const updated = updater(snapshot[index])

					// Skip no-op mutations (e.g. layout change on mount with same values)
					if (updated === snapshot[index]) return

					const nextDashboards = [...snapshot]
					nextDashboards[index] = updated

					// Optimistic update
					setDashboardsRef.current(nextDashboards)

					const result = await upsertRef.current({
						params: { dashboardId: asDashboardId(updated.id) },
						payload: new DashboardUpsertRequest({
							dashboard: toDashboardDocument(updated),
						}),
						reactivityKeys: ["dashboards", `dashboard:${updated.id}:versions`],
					})

					if (Exit.isFailure(result)) {
						// Always roll back the optimistic update before deciding
						// what to do about the error.
						setDashboardsRef.current(snapshot)

						if (isConcurrencyConflict(result)) {
							// Someone else wrote the same dashboard between our
							// read and our write. Refetch so the user picks up
							// the latest server state and can re-apply their
							// edit on top of it. Surface a transient banner so
							// the user knows their last save did not land.
							setPersistenceErrorRef.current(
								"Another editor saved changes to this dashboard. Refetching the latest version — re-apply your edit if needed.",
							)
							refetchDashboardsRef.current()
						} else {
							setPersistenceErrorRef.current(getErrorMessage(result))
						}
					}
				})

			mutationQueuesRef.current.set(dashboardId, next)

			// Drop the entry once it settles so the map doesn't grow unbounded.
			next.finally(() => {
				if (mutationQueuesRef.current.get(dashboardId) === next) {
					mutationQueuesRef.current.delete(dashboardId)
				}
			})

			await next
		},
		[],
	)

	const importDashboard = useCallback(
		async (imported: PortableDashboard): Promise<Dashboard> => {
			if (readOnly) {
				throw new Error("Dashboards are read-only")
			}

			const result = await createMutation({
				payload: new DashboardCreateRequest({
					dashboard: toPortableDashboardDocument(imported),
				}),
				reactivityKeys: ["dashboards"],
			})

			if (Exit.isFailure(result)) {
				setPersistenceError(getErrorMessage(result))
				throw new Error(getErrorMessage(result))
			}

			const dashboard = ensureDashboard(result.value)

			if (dashboard === null) {
				throw new Error("Created dashboard payload is invalid")
			}

			setDashboards((previous) => [dashboard, ...previous.filter((item) => item.id !== dashboard.id)])

			return dashboard
		},
		[createMutation, readOnly, setDashboards, setPersistenceError],
	)

	const importPersesDashboard = useCallback(
		async (
			persesDashboard: Record<string, unknown>,
		): Promise<{ dashboard: Dashboard; warnings: string[] }> => {
			if (readOnly) {
				throw new Error("Dashboards are read-only")
			}

			const result = await importPersesMutation({
				payload: new DashboardPersesImportRequest({
					dashboard: persesDashboard,
				}),
				reactivityKeys: ["dashboards"],
			})

			if (Exit.isFailure(result)) {
				setPersistenceError(getErrorMessage(result))
				throw new Error(getErrorMessage(result))
			}

			const dashboard = ensureDashboard(result.value.dashboard)
			if (dashboard === null) {
				throw new Error("Imported Perses dashboard payload is invalid")
			}

			setDashboards((previous) => [dashboard, ...previous.filter((item) => item.id !== dashboard.id)])

			return {
				dashboard,
				warnings: [...result.value.warnings],
			}
		},
		[importPersesMutation, readOnly, setDashboards, setPersistenceError],
	)

	const createDashboard = useCallback(
		async (name: string): Promise<Dashboard> => {
			if (readOnly) {
				throw new Error("Dashboards are read-only")
			}

			const result = await createMutation({
				payload: new DashboardCreateRequest({
					dashboard: toPortableDashboardDocument({
						name,
						timeRange: { type: "relative", value: "12h" },
						widgets: [],
					}),
				}),
				reactivityKeys: ["dashboards"],
			})

			if (Exit.isFailure(result)) {
				setPersistenceError(getErrorMessage(result))
				throw new Error(getErrorMessage(result))
			}

			const dashboard = ensureDashboard(result.value)

			if (dashboard === null) {
				throw new Error("Created dashboard payload is invalid")
			}

			setDashboards((previous) => [dashboard, ...previous.filter((item) => item.id !== dashboard.id)])

			return dashboard
		},
		[createMutation, readOnly, setDashboards, setPersistenceError],
	)

	const readDashboard = useCallback(
		(id: string) => dashboardsRef.current.find((d) => d.id === id),
		[],
	)

	const widgetMutators = useMemo(
		() => makeWidgetMutators({ mutateDashboard, readOnly, readDashboard }),
		[mutateDashboard, readOnly, readDashboard],
	)

	const deleteDashboard = useCallback(
		(id: string) => {
			if (readOnly) return

			const snapshot = [...dashboardsRef.current]
			const next = snapshot.filter((dashboard) => dashboard.id !== id)
			if (next.length === snapshot.length) return

			setDashboardsRef.current(next)

			void deleteRef
				.current({ params: { dashboardId: asDashboardId(id) }, reactivityKeys: ["dashboards"] })
				.then((result) => {
					if (Exit.isFailure(result)) {
						setDashboardsRef.current(snapshot)
						setPersistenceErrorRef.current(getErrorMessage(result))
					}
				})
		},
		[readOnly],
	)

	return {
		dashboards,
		isLoading,
		readOnly,
		persistenceError,
		createDashboard,
		importDashboard,
		importPersesDashboard,
		deleteDashboard,
		...widgetMutators,
	}
}

// ElectricSQL-backed implementation. Reads the dashboards list from a live query
// over the org's synced collection and routes writes through the collection's
// optimistic mutations (TanStack DB owns the optimistic apply + rollback that
// `useDashboardStoreAtoms` hand-rolls). Same public surface as the atom version.
function useDashboardStoreCollection() {
	const [persistenceError, setPersistenceError] = useAtom(persistenceErrorAtom)

	// Always resolve a collection (fallback key before the org is known — the
	// server still scopes by the auth token, so the key only isolates the local
	// cache across org switches). The dashboards route is auth-gated, so a token
	// is present in practice.
	const orgKey = useActiveOrgId() ?? "pending"
	// Re-resolve on a self-heal generation bump (post-deploy schema drift) as well
	// as an org switch, matching the alerts/errors collection hooks — otherwise
	// this memo keeps the stale, cleaned-up collection after a schema-error reset.
	const generation = useCollectionsGeneration()
	const collection = useMemo(() => getOrgCollections(orgKey).dashboards, [orgKey, generation])

	const { data: rows, isLoading: liveLoading } = useLiveQuery(
		(q) => q.from({ d: collection }).orderBy(({ d }) => d.updated_at, "desc"),
		[collection],
	)

	const dashboards = useMemo(
		() => (rows ?? []).map(rowToDashboard).filter((d): d is Dashboard => d !== null),
		[rows],
	)

	const readOnly = persistenceError !== null
	const isLoading = liveLoading && dashboards.length === 0

	const collectionRef = useRef(collection)
	collectionRef.current = collection
	const setPersistenceErrorRef = useRef(setPersistenceError)
	setPersistenceErrorRef.current = setPersistenceError
	const persistenceErrorRef = useRef(persistenceError)
	persistenceErrorRef.current = persistenceError

	// A successful write proves persistence is healthy again — clear a stale
	// banner so the UI leaves read-only without a page reload. Mirrors the atom
	// path, which clears the error on a successful list refetch. Guarded so a
	// steady stream of successful edits doesn't churn state when nothing is set.
	const clearPersistenceError = useCallback(() => {
		if (persistenceErrorRef.current !== null) setPersistenceErrorRef.current(null)
	}, [])

	const applyMutationError = useCallback((error: unknown) => {
		// TanStack DB has already rolled the optimistic state back by the time the
		// transaction rejects; surface the reason.
		const concurrency =
			error instanceof DashboardConcurrencyError ||
			(isExitLike(error) && isConcurrencyConflict(error))
		if (concurrency) {
			setPersistenceErrorRef.current(
				"Another editor saved changes to this dashboard. The latest version is loading — re-apply your edit if needed.",
			)
		} else {
			setPersistenceErrorRef.current(getErrorMessage(error))
		}
	}, [])

	const mutateDashboard = useCallback(
		// No per-dashboard FIFO queue (unlike the atom path): TanStack DB applies
		// optimistic state synchronously inside `collection.update()` — it calls
		// `recomputeOptimisticState` before returning — and `collection.get()` reads
		// that optimistic state. So back-to-back edits to the same dashboard each
		// read the previous edit's result; the whole read→update prefix below runs
		// synchronously before the first `await`. The atom queue only existed to
		// compensate for `dashboardsRef.current` (React state) lagging until the
		// next render, which reading the collection directly avoids.
		async (dashboardId: string, updater: (dashboard: Dashboard) => Dashboard): Promise<void> => {
			const active = collectionRef.current
			const row = active.get(dashboardId)
			if (!row) return
			const current = rowToDashboard(row)
			if (!current) return

			const updated = updater(current)
			if (updated === current) return // no-op

			// Store a plain (structurally-cloned) document so Immer's draft proxy
			// never wraps a Schema.Class instance; onUpdate re-decodes it.
			const nextDoc = toDashboardDocument(updated)
			const plainDoc = JSON.parse(JSON.stringify(nextDoc)) as unknown

			const tx = active.update(dashboardId, (draft) => {
				draft.payload_json = plainDoc
				draft.name = updated.name
				draft.updated_at = updated.updatedAt
			})

			try {
				await tx.isPersisted.promise
				clearPersistenceError()
			} catch (error) {
				applyMutationError(error)
			}
		},
		[applyMutationError, clearPersistenceError],
	)

	const importDashboard = useCallback(
		async (imported: PortableDashboard): Promise<Dashboard> => {
			if (readOnly) throw new Error("Dashboards are read-only")
			const result = await runMapleApi((client) =>
				client.dashboards.create({
					payload: new DashboardCreateRequest({
						dashboard: toPortableDashboardDocument(imported),
					}),
				}),
			).catch((error) => {
				setPersistenceError(getErrorMessage(error))
				throw new Error(getErrorMessage(error))
			})

			const dashboard = ensureDashboard(result)
			if (dashboard === null) throw new Error("Created dashboard payload is invalid")
			if (result.txid !== undefined) {
				await collectionRef.current.utils.awaitTxId(Number(result.txid)).catch(() => undefined)
			}
			return dashboard
		},
		[readOnly, setPersistenceError],
	)

	const importPersesDashboard = useCallback(
		async (
			persesDashboard: Record<string, unknown>,
		): Promise<{ dashboard: Dashboard; warnings: string[] }> => {
			if (readOnly) throw new Error("Dashboards are read-only")
			const result = await runMapleApi((client) =>
				client.dashboards.importPerses({
					payload: new DashboardPersesImportRequest({ dashboard: persesDashboard }),
				}),
			).catch((error) => {
				setPersistenceError(getErrorMessage(error))
				throw new Error(getErrorMessage(error))
			})

			const dashboard = ensureDashboard(result.dashboard)
			if (dashboard === null) throw new Error("Imported Perses dashboard payload is invalid")
			if (result.txid !== undefined) {
				await collectionRef.current.utils.awaitTxId(Number(result.txid)).catch(() => undefined)
			}
			return { dashboard, warnings: [...result.warnings] }
		},
		[readOnly, setPersistenceError],
	)

	const createDashboard = useCallback(
		async (name: string): Promise<Dashboard> => {
			return importDashboard({
				name,
				timeRange: { type: "relative", value: "12h" },
				widgets: [],
			} as PortableDashboard)
		},
		[importDashboard],
	)

	const readDashboard = useCallback((id: string) => {
		const row = collectionRef.current.get(id)
		return row ? (rowToDashboard(row) ?? undefined) : undefined
	}, [])

	const widgetMutators = useMemo(
		() => makeWidgetMutators({ mutateDashboard, readOnly, readDashboard }),
		[mutateDashboard, readOnly, readDashboard],
	)

	const deleteDashboard = useCallback(
		(id: string) => {
			if (readOnly) return
			const active = collectionRef.current
			if (!active.get(id)) return
			const tx = active.delete(id)
			void tx.isPersisted.promise.catch((error: unknown) => applyMutationError(error))
		},
		[readOnly, applyMutationError],
	)

	return {
		dashboards,
		isLoading,
		readOnly,
		persistenceError,
		createDashboard,
		importDashboard,
		importPersesDashboard,
		deleteDashboard,
		...widgetMutators,
	}
}

// Build-time dispatch. `ELECTRIC_SYNC_ENABLED` is a compile-time constant, so
// exactly one branch survives bundling and hook order is stable per build.
export function useDashboardStore() {
	if (ELECTRIC_SYNC_ENABLED) {
		// eslint-disable-next-line react-hooks/rules-of-hooks
		return useDashboardStoreCollection()
	}
	// eslint-disable-next-line react-hooks/rules-of-hooks
	return useDashboardStoreAtoms()
}
