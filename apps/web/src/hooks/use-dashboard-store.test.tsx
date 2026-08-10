// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { WidgetDataSource } from "@/components/dashboard-builder/types"
import type { DashboardRow } from "@/lib/collections/dashboards"

// A stand-in for the Electric-synced collection. `useDashboardMutations` runs no
// live query, so the write half only needs `get`/`update`/`delete` plus the txid
// util — which makes the whole mutator surface testable without a shape stream.

const rows = new Map<string, DashboardRow>()
let persistResult: () => Promise<void> = () => Promise.resolve()

const collection = {
	id: "dashboards:org_test",
	get: (id: string) => rows.get(id),
	update: (id: string, updater: (draft: DashboardRow) => void) => {
		const next = structuredClone(rows.get(id)!)
		updater(next)
		rows.set(id, next)
		return { isPersisted: { promise: persistResult() } }
	},
	delete: (id: string) => {
		rows.delete(id)
		return { isPersisted: { promise: persistResult() } }
	},
	preload: () => Promise.resolve(),
	utils: { awaitTxId: () => Promise.resolve(true) },
}

vi.mock("@/lib/collections/org-collections", () => ({
	getOrgCollections: () => ({ dashboards: collection }),
	useActiveOrgId: () => "org_test",
	useCollectionsGeneration: () => 0,
	retryOrgCollections: () => undefined,
	handleCollectionStuck: () => undefined,
}))

const toastAdd = vi.fn()
vi.mock("@maple/ui/components/ui/toast", () => ({
	toastManager: {
		add: (...args: unknown[]) => toastAdd(...args),
	},
}))

const { useDashboardMutations } = await import("@/hooks/use-dashboard-store")
const { persistenceErrorAtom } = await import("@/atoms/dashboard-store-atoms")
const { useAtom } = await import("@/lib/effect-atom")

/**
 * The mutations plus a handle on the persistence banner. `persistenceErrorAtom`
 * is module-level shared state, so a latched error from one test would leave
 * every later one read-only.
 */
const useStoreUnderTest = () => {
	const [persistenceError, setPersistenceError] = useAtom(persistenceErrorAtom)
	return { ...useDashboardMutations(), persistenceError, setPersistenceError }
}

const ISO = "2026-01-01T00:00:00.000Z"

const makeRow = (id: string, widgets: ReadonlyArray<unknown> = []): DashboardRow => ({
	org_id: "org_test",
	id,
	name: `Dashboard ${id}`,
	payload_json: {
		id,
		name: `Dashboard ${id}`,
		timeRange: { type: "relative", value: "12h" },
		widgets,
		createdAt: ISO,
		updatedAt: ISO,
	},
	created_at: ISO,
	updated_at: ISO,
	created_by: "user_test",
	updated_by: "user_test",
	version: 1,
})

const chartDataSource: WidgetDataSource = {
	endpoint: "custom_query_builder_timeseries",
	params: { queries: [], formulas: [] },
}

const widgetsOf = (id: string) =>
	(rows.get(id)!.payload_json as { widgets: ReadonlyArray<{ id: string }> }).widgets

/** Mounts the hook with the shared persistence banner cleared. */
const mountStore = () => {
	const rendered = renderHook(() => useStoreUnderTest())
	if (rendered.result.current.persistenceError !== null) {
		act(() => rendered.result.current.setPersistenceError(null))
	}
	return rendered
}

beforeEach(() => {
	rows.clear()
	toastAdd.mockClear()
	persistResult = () => Promise.resolve()
})

afterEach(cleanup)

describe("addWidget", () => {
	it("lands the widget in the dashboard's stored payload", async () => {
		rows.set("dash_a", makeRow("dash_a"))
		const { result } = mountStore()

		await act(async () => {
			result.current.addWidget("dash_a", "chart", chartDataSource, { title: "Errors" })
		})

		expect(widgetsOf("dash_a")).toHaveLength(1)
	})

	it("places the second widget beside the first rather than on top of it", async () => {
		rows.set("dash_a", makeRow("dash_a"))
		const { result } = mountStore()

		await act(async () => {
			result.current.addWidget("dash_a", "chart", chartDataSource, { title: "One" })
		})
		await act(async () => {
			result.current.addWidget("dash_a", "chart", chartDataSource, { title: "Two" })
		})

		const layouts = (
			rows.get("dash_a")!.payload_json as { widgets: ReadonlyArray<{ layout: { x: number } }> }
		).widgets.map((w) => w.layout.x)
		expect(layouts).toEqual([0, 4])
	})

	it("throws instead of silently dropping the widget when the dashboard isn't loaded", () => {
		const { result } = mountStore()

		// The regression this guards: `mutateDashboard` used to `return` on a
		// collection miss, so the caller got a widget back, the picker closed, and
		// nothing was ever written or rendered.
		expect(() =>
			result.current.addWidget("dash_missing", "chart", chartDataSource, { title: "Errors" }),
		).toThrow(/may still be loading/)
	})

	it("throws when the dashboard's stored payload can't be decoded", () => {
		const corrupt = makeRow("dash_bad")
		rows.set("dash_bad", { ...corrupt, payload_json: { nope: true } })
		const { result } = mountStore()

		expect(() =>
			result.current.addWidget("dash_bad", "chart", chartDataSource, { title: "Errors" }),
		).toThrow(/Couldn’t read this dashboard/)
	})
})

describe("write failures", () => {
	it("surfaces a rejected persist on the banner instead of an unhandled rejection", async () => {
		rows.set("dash_a", makeRow("dash_a"))
		persistResult = () => Promise.reject(new Error("PATCH /v2/dashboards failed"))

		const { result, rerender } = mountStore()

		await act(async () => {
			result.current.addWidget("dash_a", "chart", chartDataSource, { title: "Errors" })
			await Promise.resolve()
		})
		rerender()

		expect(result.current.persistenceError).toBe("PATCH /v2/dashboards failed")
		expect(result.current.readOnly).toBe(true)
	})

	it("tells the user when the write landed but this tab's sync fell behind", async () => {
		rows.set("dash_a", makeRow("dash_a"))
		const timeout = new Error("Timeout waiting for txId 42")
		persistResult = () => Promise.reject(timeout)

		const { result, rerender } = mountStore()

		await act(async () => {
			result.current.addWidget("dash_a", "chart", chartDataSource, { title: "Errors" })
			await Promise.resolve()
		})
		rerender()

		// Editing stays enabled — the server has the write — but the rollback is no
		// longer silent.
		expect(result.current.persistenceError).toBeNull()
		expect(toastAdd).toHaveBeenCalledWith(
			expect.objectContaining({ title: expect.stringContaining("Saved") }),
		)
	})
})
