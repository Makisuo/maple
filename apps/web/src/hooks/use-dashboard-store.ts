import { useAtom } from "@/lib/effect-atom"
import { useCallback, useMemo } from "react"
import { Cause, Exit, Option, Schema } from "effect"
import {
	DashboardConcurrencyError,
	DashboardDocument,
	DashboardId,
	IsoDateTimeString,
	PortableDashboardDocument,
} from "@maple/domain/http"
import type { V2DashboardMutation } from "@maple/domain/http/v2"
import { useLiveQuery } from "@tanstack/react-db"
import { runMapleApiV2 } from "@/lib/collections/api-runner"
import { rowToDashboard } from "@/lib/collections/dashboards"
import {
	getOrgCollections,
	handleCollectionStuck,
	useActiveOrgId,
	useCollectionsGeneration,
} from "@/lib/collections/org-collections"
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
import { persistenceErrorAtom } from "@/atoms/dashboard-store-atoms"

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

// Walk the `cause` chain for the most specific message. The Electric write
// handlers wrap every typed failure in a generic UpdateError ("Update operation
// failed") whose `cause` carries the actual HTTP/auth error — surfacing only the
// wrapper made prod failures undiagnosable.
function messageFromErrorChain(error: unknown, depth = 0): string | null {
	if (depth > 5 || typeof error !== "object" || error === null) return null
	const cause = (error as { cause?: unknown }).cause
	const causeMessage = cause !== undefined ? messageFromErrorChain(cause, depth + 1) : null
	if (causeMessage) return causeMessage
	return messageFromError(error)
}

function getErrorMessage(error: unknown): string {
	const directMessage = messageFromErrorChain(error)
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

// Detect the Electric txid-await timing out AFTER the PATCH succeeded: the
// server persisted the write, but this tab's shape stream is dead/stuck so the
// txid never appears and TanStack DB rolls the optimistic state back. Latching
// the read-only banner here would punish a *successful* write; instead the
// caller triggers the stuck-collection self-heal so a fresh stream re-syncs the
// saved row.
function isTxidAwaitTimeout(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false
	const named = error as { name?: unknown; message?: unknown }
	if (named.name === "TimeoutWaitingForTxIdError") return true
	return typeof named.message === "string" && named.message.includes("Timeout waiting for txId")
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

const v2DashboardToDashboard = (value: V2DashboardMutation): Dashboard => ({
	id: value.id,
	name: value.name,
	...(value.description !== null ? { description: value.description } : {}),
	tags: [...value.tags],
	timeRange: value.timeRange,
	widgets: [...value.widgets] as Dashboard["widgets"],
	variables: [...value.variables] as Dashboard["variables"],
	createdAt: value.createdAt,
	updatedAt: value.updatedAt,
})

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

// Deep-clone via JSON so present-`undefined` keys are dropped, not preserved
// (structuredClone keeps them, and the v2 `optionalKey` encode rejects them —
// see the note in `mutateDashboard`).
const jsonClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function toPortableDashboardDocument(dashboard: PortableDashboard): PortableDashboardDocument {
	// See `toDashboardDocument`: omit the optionalKey `description`/`tags`/`variables`
	// rather than forwarding a present `undefined`, which the Schema.Class constructor rejects.
	const { description, tags, variables, ...rest } = dashboard
	return new PortableDashboardDocument({
		...rest,
		...(description !== undefined && { description }),
		...(tags !== undefined && { tags: [...tags] }),
		...(variables !== undefined && { variables: jsonClone(variables) }),
		widgets: jsonClone(dashboard.widgets),
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

// The dashboard/widget mutators: each is a pure `(Dashboard) => Dashboard`
// transform pushed through the injected `mutateDashboard`. `readDashboard`
// supplies the current dashboard (from the collection) for the two mutators
// that read it.
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

// Always resolve a collection (fallback key before the org is known — the
// server still scopes by the auth token, so the key only isolates the local
// cache across org switches). The dashboards routes are auth-gated, so a token
// is present in practice. Re-resolves on a self-heal generation bump
// (post-deploy schema drift) as well as an org switch, matching the
// alerts/errors collection hooks — otherwise the memo keeps the stale,
// cleaned-up collection after a schema-error reset.
export function useDashboardsCollection() {
	const orgKey = useActiveOrgId() ?? "pending"
	const generation = useCollectionsGeneration()
	return useMemo(() => getOrgCollections(orgKey).dashboards, [orgKey, generation])
}

export function useDashboardMutationSync() {
	const collection = useDashboardsCollection()
	const prepareForMutation = useCallback(() => {
		void collection.preload().catch(() => undefined)
	}, [collection])
	const reconcileTxid = useCallback(
		async (txid: V2DashboardMutation["txid"]): Promise<void> => {
			if (txid === undefined) return
			await collection.utils.awaitTxId(Number(txid)).catch(() => undefined)
		},
		[collection],
	)
	return { prepareForMutation, reconcileTxid }
}

// The read half of the ElectricSQL-backed dashboard store: a live query over
// the org's synced collection, mapped to the web `Dashboard` shape. Global
// chrome (sidebar, command palette) uses this directly — it needs the list but
// none of the mutators.
export function useDashboardsRead() {
	const collection = useDashboardsCollection()

	const {
		data: rows,
		isLoading: liveLoading,
		isError,
	} = useLiveQuery((q) => q.from({ d: collection }).orderBy(({ d }) => d.updated_at, "desc"), [collection])

	const dashboards = useMemo(
		() => (rows ?? []).map(rowToDashboard).filter((d): d is Dashboard => d !== null),
		[rows],
	)

	const isLoading = liveLoading && dashboards.length === 0

	return { dashboards, isLoading, isError }
}

// The write half: create/import/delete plus the per-dashboard widget mutators,
// all routed through the collection's optimistic mutations (TanStack DB owns
// the optimistic apply + rollback). Resolves the collection itself but runs NO
// live query — mounting this hook adds no read subscription, so action-only
// consumers (the dashboards list route) don't double-subscribe the shape
// stream alongside their model/read hook.
export function useDashboardMutations() {
	const [persistenceError, setPersistenceError] = useAtom(persistenceErrorAtom)
	const collection = useDashboardsCollection()

	const readOnly = persistenceError !== null

	// A successful write proves persistence is healthy again — clear a stale
	// banner so the UI leaves read-only without a page reload. Mirrors the atom
	// path, which clears the error on a successful list refetch.
	const clearPersistenceError = useCallback(() => {
		setPersistenceError(null)
	}, [setPersistenceError])

	const applyMutationError = useCallback(
		(error: unknown) => {
			// TanStack DB has already rolled the optimistic state back by the time the
			// transaction rejects; surface the reason.
			if (isTxidAwaitTimeout(error)) {
				// The write reached the server (the handler returned a txid) — only the
				// sync-back timed out because this tab's shape stream is dead. Heal the
				// stream instead of disabling editing; the refetch restores the saved row.
				handleCollectionStuck()
				return
			}
			const concurrency =
				error instanceof DashboardConcurrencyError ||
				(isExitLike(error) && isConcurrencyConflict(error))
			if (concurrency) {
				setPersistenceError(
					"Another editor saved changes to this dashboard. The latest version is loading — re-apply your edit if needed.",
				)
			} else {
				setPersistenceError(getErrorMessage(error))
			}
		},
		[setPersistenceError],
	)

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
			const active = collection
			const row = active.get(dashboardId)
			if (!row) return
			const current = rowToDashboard(row)
			if (!current) return

			const updated = updater(current)
			if (updated === current) return // no-op

			// Store a plain JSON-round-tripped document so Immer's draft proxy never
			// wraps a Schema.Class instance; onUpdate re-decodes it. JSON (not
			// structuredClone) on purpose: widget builders spread optional fields as
			// present-`undefined` keys (e.g. `transform: undefined`), which
			// structuredClone preserves — and the v2 PATCH encode (`optionalKey`
			// fields) rejects a present undefined, failing the whole save
			// ("Expected object, got undefined at [widgets][i][dataSource][transform]").
			// The JSON round-trip drops them, exactly matching what the server's
			// jsonb storage would keep anyway.
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
		[applyMutationError, clearPersistenceError, collection],
	)

	const importDashboard = useCallback(
		async (imported: PortableDashboard): Promise<Dashboard> => {
			if (readOnly) throw new Error("Dashboards are read-only")
			const portable = toPortableDashboardDocument(imported)
			const result = await runMapleApiV2((client) =>
				client.dashboards.create({
					payload: {
						name: portable.name,
						...(portable.description !== undefined ? { description: portable.description } : {}),
						...(portable.tags !== undefined ? { tags: portable.tags } : {}),
						timeRange: portable.timeRange,
						widgets: portable.widgets,
						...(portable.variables !== undefined ? { variables: portable.variables } : {}),
					},
				}),
			).catch((error) => {
				setPersistenceError(getErrorMessage(error))
				throw new Error(getErrorMessage(error))
			})

			const dashboard = v2DashboardToDashboard(result)
			if (result.txid !== undefined) {
				await collection.utils.awaitTxId(Number(result.txid)).catch(() => undefined)
			}
			return dashboard
		},
		[collection, readOnly, setPersistenceError],
	)

	const importPersesDashboard = useCallback(
		async (
			persesDashboard: Record<string, unknown>,
		): Promise<{ dashboard: Dashboard; warnings: string[] }> => {
			if (readOnly) throw new Error("Dashboards are read-only")
			const result = await runMapleApiV2((client) =>
				client.dashboards.importPerses({
					payload: { dashboard: persesDashboard },
				}),
			).catch((error) => {
				setPersistenceError(getErrorMessage(error))
				throw new Error(getErrorMessage(error))
			})

			const dashboard = v2DashboardToDashboard(result.dashboard)
			if (result.dashboard.txid !== undefined) {
				await collection.utils.awaitTxId(Number(result.dashboard.txid)).catch(() => undefined)
			}
			return { dashboard, warnings: [...result.warnings] }
		},
		[collection, readOnly, setPersistenceError],
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

	const readDashboard = useCallback(
		(id: string) => {
			const row = collection.get(id)
			return row ? (rowToDashboard(row) ?? undefined) : undefined
		},
		[collection],
	)

	const widgetMutators = useMemo(
		() => makeWidgetMutators({ mutateDashboard, readOnly, readDashboard }),
		[mutateDashboard, readOnly, readDashboard],
	)

	const deleteDashboard = useCallback(
		(id: string) => {
			if (readOnly) return
			const active = collection
			if (!active.get(id)) return
			const tx = active.delete(id)
			void tx.isPersisted.promise.catch((error: unknown) => applyMutationError(error))
		},
		[collection, readOnly, applyMutationError],
	)

	return {
		readOnly,
		persistenceError,
		createDashboard,
		importDashboard,
		importPersesDashboard,
		deleteDashboard,
		...widgetMutators,
	}
}

// The full store — read + mutations — for consumers that need both (the
// dashboard detail route, the widget route, the toolbar). `persistenceErrorAtom`
// is module-level shared state, so the split halves stay coherent.
export function useDashboardStore() {
	return { ...useDashboardsRead(), ...useDashboardMutations() }
}
