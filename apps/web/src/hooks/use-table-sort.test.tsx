// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { useTableSort } from "./use-table-sort"

afterEach(cleanup)

interface Row {
	service: string
	calls: string
	p99: number
}

const ROWS: Row[] = [
	{ service: "api-gateway", calls: "1820", p99: 245 },
	{ service: "billing", calls: "240", p99: 412 },
	{ service: "auth", calls: "98", p99: 89 },
]

const services = (rows: ReadonlyArray<Row>) => rows.map((r) => r.service)

describe("useTableSort", () => {
	it("keeps source order when the initial key is null", () => {
		const { result } = renderHook(() => useTableSort<Row, keyof Row>(ROWS, { initialKey: null }))
		expect(services(result.current.sorted)).toEqual(["api-gateway", "billing", "auth"])
		expect(result.current.sortKey).toBeNull()
	})

	it("sorts string-encoded counts numerically, not lexicographically", () => {
		// 64-bit ints arrive quoted from BYO-ClickHouse. Lexicographic order would
		// put "98" above "1820".
		const { result } = renderHook(() => useTableSort<Row, keyof Row>(ROWS, { initialKey: null }))
		act(() => result.current.handleSort("calls"))
		expect(services(result.current.sorted)).toEqual(["api-gateway", "billing", "auth"])
		act(() => result.current.handleSort("calls"))
		expect(services(result.current.sorted)).toEqual(["auth", "billing", "api-gateway"])
	})

	it("sorts numbers descending first, then ascending", () => {
		const { result } = renderHook(() => useTableSort<Row, keyof Row>(ROWS, { initialKey: null }))
		act(() => result.current.handleSort("p99"))
		expect(services(result.current.sorted)).toEqual(["billing", "api-gateway", "auth"])
		act(() => result.current.handleSort("p99"))
		expect(services(result.current.sorted)).toEqual(["auth", "api-gateway", "billing"])
	})

	it("sorts non-numeric strings alphabetically", () => {
		const { result } = renderHook(() =>
			useTableSort<Row, keyof Row>(ROWS, { initialKey: null, stringKeys: ["service"] }),
		)
		act(() => result.current.handleSort("service"))
		expect(services(result.current.sorted)).toEqual(["api-gateway", "auth", "billing"])
	})

	it("cycles desc → asc → source order when resettable", () => {
		const { result } = renderHook(() =>
			useTableSort<Row, keyof Row>(ROWS, { initialKey: null, resettable: true }),
		)
		act(() => result.current.handleSort("p99"))
		expect(result.current.sortDir).toBe("desc")
		act(() => result.current.handleSort("p99"))
		expect(result.current.sortDir).toBe("asc")
		act(() => result.current.handleSort("p99"))
		expect(result.current.sortKey).toBeNull()
		expect(services(result.current.sorted)).toEqual(["api-gateway", "billing", "auth"])
	})

	it("toggles indefinitely when not resettable (the infra tables)", () => {
		const { result } = renderHook(() => useTableSort<Row, keyof Row>(ROWS, { initialKey: "p99" }))
		expect(services(result.current.sorted)).toEqual(["billing", "api-gateway", "auth"])
		act(() => result.current.handleSort("p99"))
		expect(result.current.sortDir).toBe("asc")
		act(() => result.current.handleSort("p99"))
		expect(result.current.sortDir).toBe("desc")
		expect(result.current.sortKey).toBe("p99")
	})

	it("keeps pinned rows on top in both directions", () => {
		const { result } = renderHook(() =>
			useTableSort<Row, keyof Row>(ROWS, {
				initialKey: "p99",
				pinned: (row) => row.service === "auth",
			}),
		)
		expect(services(result.current.sorted)).toEqual(["auth", "billing", "api-gateway"])
		act(() => result.current.handleSort("p99"))
		expect(services(result.current.sorted)).toEqual(["auth", "api-gateway", "billing"])
	})
})
