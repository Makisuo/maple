// @vitest-environment jsdom
// TEST-SEAM: The pagination hook consumes a module-global runtime and route-backed atoms.
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Result } from "@/lib/effect-atom"
import type { LogsResponse } from "@/api/warehouse/logs"
import { useInfiniteLogs } from "./use-infinite-logs"

const mocks = vi.hoisted(() => ({
	runPromise: vi.fn(),
	firstPage: vi.fn(),
	logClientError: vi.fn(),
}))

vi.mock("@/lib/registry", () => ({ mapleRuntime: { runPromise: mocks.runPromise } }))
vi.mock("@/lib/services/common/telemetry", () => ({ logClientError: mocks.logClientError }))
vi.mock("@/api/warehouse/logs", () => ({ listLogs: (input: unknown) => input }))
vi.mock("@/lib/services/atoms/warehouse-query-atoms", () => ({
	listLogsResultAtom: (input: unknown) => input,
}))
vi.mock("./use-refreshable-atom-value", () => ({ useRefreshableAtomValue: mocks.firstPage }))
vi.mock("./use-global-namespace", () => ({ useGlobalNamespace: () => null }))
vi.mock("./use-table-refresh-time-range", () => ({
	useTableRefreshTimeRange: () => ({
		startTime: "2026-09-01 00:00:00",
		endTime: "2026-09-02 00:00:00",
	}),
}))

function page(body: string, cursor: string | null = "next"): LogsResponse {
	return {
		data: [
			{
				timestamp: "2026-09-01 12:00:00",
				severityText: "INFO",
				severityNumber: 9,
				serviceName: "api",
				body,
				traceId: undefined,
				spanId: undefined,
				logAttributes: {},
				resourceAttributes: {},
			},
		],
		meta: { limit: 100, cursor },
	}
}

function pendingPage() {
	let resolve!: (value: LogsResponse) => void
	const promise = new Promise<LogsResponse>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

beforeEach(() => {
	vi.resetAllMocks()
	mocks.firstPage.mockReturnValue(Result.success(page("first")))
})

afterEach(cleanup)

describe("useInfiniteLogs", () => {
	it("stops automatic pagination after a failure and permits retry after refresh", async () => {
		const failure = new Error("cursor rejected")
		mocks.runPromise.mockRejectedValueOnce(failure)
		const { result, rerender } = renderHook(() => useInfiniteLogs(undefined))

		await act(async () => result.current.fetchNextPage())
		expect(result.current.hasNextPage).toBe(false)
		expect(result.current.isFetchingNextPage).toBe(false)
		expect(result.current.allData.map((log) => log.body)).toEqual(["first"])
		expect(mocks.logClientError).toHaveBeenCalledWith("logs.pagination_failed", failure)

		await act(async () => result.current.fetchNextPage())
		expect(mocks.runPromise).toHaveBeenCalledTimes(1)

		mocks.firstPage.mockReturnValue(Result.success(page("refreshed", "fresh-cursor")))
		rerender()
		mocks.runPromise.mockResolvedValueOnce(page("next page", null))
		await act(async () => result.current.fetchNextPage())
		expect(mocks.runPromise).toHaveBeenLastCalledWith({
			data: expect.objectContaining({ cursor: "fresh-cursor" }),
		})
		expect(result.current.allData.map((log) => log.body)).toEqual(["refreshed", "next page"])
	})

	it("discards accumulated pages when the first page is refreshed", async () => {
		mocks.runPromise.mockResolvedValueOnce(page("old second page"))
		const { result, rerender } = renderHook(() => useInfiniteLogs(undefined))
		await act(async () => result.current.fetchNextPage())
		expect(result.current.allData).toHaveLength(2)

		mocks.firstPage.mockReturnValue(Result.success(page("refreshed")))
		rerender()
		expect(result.current.allData.map((log) => log.body)).toEqual(["refreshed"])
	})

	it("does not let an older request clear the current request's guard", async () => {
		const oldRequest = pendingPage()
		const newRequest = pendingPage()
		mocks.runPromise.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise)
		const { result, rerender } = renderHook(({ search }) => useInfiniteLogs({ search }), {
			initialProps: { search: "old" },
		})
		act(() => result.current.fetchNextPage())
		rerender({ search: "new" })
		act(() => result.current.fetchNextPage())

		await act(async () => oldRequest.resolve(page("stale")))
		expect(result.current.isFetchingNextPage).toBe(true)
		act(() => result.current.fetchNextPage())
		expect(mocks.runPromise).toHaveBeenCalledTimes(2)

		await act(async () => newRequest.resolve(page("current", null)))
		expect(result.current.allData.map((log) => log.body)).toEqual(["first", "current"])
		expect(result.current.isFetchingNextPage).toBe(false)
	})

	it("ignores a stale page after leaving and returning to the same filter", async () => {
		const oldRequest = pendingPage()
		mocks.runPromise.mockReturnValueOnce(oldRequest.promise)
		const { result, rerender } = renderHook(({ search }) => useInfiniteLogs({ search }), {
			initialProps: { search: "a" },
		})
		act(() => result.current.fetchNextPage())
		rerender({ search: "b" })
		rerender({ search: "a" })

		await act(async () => oldRequest.resolve(page("stale")))
		expect(result.current.allData.map((log) => log.body)).toEqual(["first"])
	})

	it("waits for the current first page instead of fetching with a retained cursor", () => {
		mocks.firstPage.mockReturnValue(Result.success(page("retained"), { waiting: true }))
		const { result } = renderHook(() => useInfiniteLogs(undefined))
		act(() => result.current.fetchNextPage())
		expect(mocks.runPromise).not.toHaveBeenCalled()
	})
})
