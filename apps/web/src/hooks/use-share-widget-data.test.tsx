// @vitest-environment jsdom
// TEST-SEAM: `fetch` is process-global; the hook has no injection seam for it.
/**
 * The share hook hands renderers the same `WidgetDataState` the signed-in hook
 * does — envelope unwrapped, transform applied — for every kind of tile.
 *
 * The bug this pins: the API answers `{ data: rows }` (the envelope the
 * browser's server functions return), and the share hook once stored that
 * object as-is. Stat tiles survived because `applyTransform` happens to unwrap
 * `.data`; every chart on a shared board got an object where an array belongs
 * and drew its sample data instead of the org's.
 */
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useShareWidgetData, type ShareWidget } from "@/hooks/use-share-dashboard"

const widgets: ReadonlyArray<ShareWidget> = [
	{
		id: "w-chart",
		visualization: "chart",
		display: { title: "P95" },
		layout: { x: 0, y: 0, w: 6, h: 4 },
		dataSource: { kind: "query", resultShape: "timeseries" },
	},
	{
		id: "w-stat",
		visualization: "stat",
		display: { title: "Latency" },
		layout: { x: 6, y: 0, w: 3, h: 2 },
		dataSource: {
			kind: "route",
			transform: { reduceToValue: { field: "p95LatencyMs", aggregate: "avg" } },
		},
	},
	{
		id: "w-table",
		visualization: "table",
		display: { title: "Slowest" },
		layout: { x: 0, y: 4, w: 6, h: 4 },
		dataSource: { kind: "query", resultShape: "breakdown", transform: { limit: 1 } },
	},
]

const rows = [
	{ bucket: "2026-01-01T00:00:00.000Z", "api-v2": 12, "config-api": 3 },
	{ bucket: "2026-01-01T00:05:00.000Z", "api-v2": 15, "config-api": 4 },
]

const response = {
	variables: { service: "checkout", env: "$__all" },
	results: [
		{ widgetId: "w-chart", ok: true, data: { data: rows } },
		{ widgetId: "w-stat", ok: true, data: { data: [{ p95LatencyMs: 10 }, { p95LatencyMs: 20 }] } },
		{
			widgetId: "w-table",
			ok: true,
			data: {
				data: [
					{ name: "GET /a", value: 9 },
					{ name: "GET /b", value: 4 },
				],
			},
		},
	],
}

const WINDOW = { startTime: "2026-01-01 00:00:00", endTime: "2026-01-01 01:00:00" }

describe("useShareWidgetData", () => {
	const fetchMock = vi.fn()

	beforeEach(() => {
		fetchMock.mockReset()
		fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(response) })
		vi.stubGlobal("fetch", fetchMock)
	})

	afterEach(() => {
		cleanup()
		vi.unstubAllGlobals()
	})

	it("unwraps the envelope and applies the transform, like the signed-in hook", async () => {
		const { result } = renderHook(() =>
			useShareWidgetData("mshare_test", widgets, WINDOW, {}, true, false),
		)

		await waitFor(() => expect(result.current.states["w-table"]?.status).toBe("ready"))

		// A chart gets the rows themselves — an array — never `{ data: rows }`.
		expect(result.current.states["w-chart"]).toEqual({ status: "ready", data: rows })
		// A stat's reducer runs over the unwrapped rows.
		expect(result.current.states["w-stat"]).toEqual({ status: "ready", data: 15 })
		// A table's row cap applies.
		expect(result.current.states["w-table"]).toEqual({
			status: "ready",
			data: [{ name: "GET /a", value: 9 }],
		})
		// The server's resolved variables come back in the shape the title
		// interpolator reads, All flagged as such.
		expect(result.current.variables).toEqual({
			service: { value: "checkout", isAll: false, options: [] },
			env: { value: "$__all", isAll: true, options: [] },
		})
	})

	it("posts the board's window and every widget id, four to a batch", async () => {
		renderHook(() => useShareWidgetData("mshare_test", widgets, WINDOW, {}, true, false))

		await waitFor(() => expect(fetchMock).toHaveBeenCalled())
		// SAFETY: the hook calls `fetch(url, init)` and nothing else; the first
		// call's arguments are exactly that pair.
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toMatch(/\/v2\/share\/widget-data$/)
		// SAFETY: the body is the JSON the hook itself serialised; only these two
		// keys are read and both are compared structurally.
		const body = JSON.parse(String(init.body)) as { timeRange: unknown; requests: unknown }
		expect(body.timeRange).toEqual(WINDOW)
		expect(body.requests).toEqual([
			{ widgetId: "w-chart" },
			{ widgetId: "w-stat" },
			{ widgetId: "w-table" },
		])
	})
	it("sends each tile's measured width and refetches only the tile whose width changed", async () => {
		const options = { "w-chart": { maxDataPoints: 800 }, "w-stat": { maxDataPoints: 300 } }
		const { rerender } = renderHook(
			({ opts }) => useShareWidgetData("mshare_test", widgets, WINDOW, {}, true, false, opts),
			{ initialProps: { opts: options } },
		)

		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
		// SAFETY: the hook calls `fetch(url, init)`; the body is its own JSON.
		const first = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as {
			requests: unknown
		}
		expect(first.requests).toEqual([
			{ widgetId: "w-chart", maxDataPoints: 800 },
			{ widgetId: "w-stat", maxDataPoints: 300 },
			{ widgetId: "w-table" },
		])

		// The chart tile settles on a wider width: one request, for that tile only.
		rerender({ opts: { ...options, "w-chart": { maxDataPoints: 1200 } } })
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
		// SAFETY: same shape as above.
		const second = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)) as {
			requests: unknown
		}
		expect(second.requests).toEqual([{ widgetId: "w-chart", maxDataPoints: 1200 }])
	})
})
