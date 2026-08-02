// Client-side column sorting shared by the infra resource tables and the
// dashboard table widget.
//
// This used to live inside `components/infra/primitives/data-table.tsx`. It
// moved out when the dashboard table widget needed the same comparator: the
// widget renders arbitrary warehouse rows, so it cannot import an infra
// primitive, and a second comparator would immediately disagree with the first
// about numeric strings.

import { useMemo, useState } from "react"

export type SortDir = "asc" | "desc"

interface UseTableSortOptions<K, Row> {
	/**
	 * Column sorted on first render, or `null` to start in source order — for
	 * tables whose incoming order is itself meaningful (a warehouse `ORDER BY`).
	 */
	initialKey: K | null
	initialDir?: SortDir
	/** Keys that should default to ascending on first click (names, namespaces, …). */
	stringKeys?: ReadonlyArray<K>
	/**
	 * Let a third click on the active column clear the sort and return to source
	 * order. Off by default: a table with a fixed initial sort has no meaningful
	 * "unsorted" state to return to.
	 */
	resettable?: boolean
	/**
	 * Rows matching this always sort above the rest, in every column and direction —
	 * for the one row that is categorically different (a production branch among
	 * ephemeral ones). Stable sort can't express this: it only preserves order
	 * among ties.
	 */
	pinned?: (row: Row) => boolean
}

/**
 * Numeric when both sides are numbers, or both are strings that parse as finite
 * numbers — 64-bit ints arrive from BYO-ClickHouse quoted, so a table column of
 * counts is a column of strings and `localeCompare` would rank "100" below "20".
 * Anything else compares as text.
 */
function compareValues(av: unknown, bv: unknown, dir: SortDir): number {
	const numeric =
		(typeof av === "number" && typeof bv === "number") || (isNumericString(av) && isNumericString(bv))
	if (numeric) {
		const an = Number(av)
		const bn = Number(bv)
		const cmp = an < bn ? -1 : an > bn ? 1 : 0
		return dir === "asc" ? cmp : -cmp
	}
	const as = String(av)
	const bs = String(bv)
	return dir === "asc" ? as.localeCompare(bs) : bs.localeCompare(as)
}

function isNumericString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
}

export function useTableSort<Row, K extends keyof Row>(
	rows: ReadonlyArray<Row>,
	{ initialKey, initialDir = "desc", stringKeys, resettable = false, pinned }: UseTableSortOptions<K, Row>,
) {
	const [sortKey, setSortKey] = useState<K | null>(initialKey)
	const [sortDir, setSortDir] = useState<SortDir>(initialDir)

	const handleSort = (k: K) => {
		if (k === sortKey) {
			// desc → asc → (resettable) source order
			if (sortDir === "asc" && resettable) {
				setSortKey(null)
				return
			}
			setSortDir((d) => (d === "asc" ? "desc" : "asc"))
		} else {
			setSortKey(k)
			setSortDir(stringKeys?.includes(k) ? "asc" : "desc")
		}
	}

	const sorted = useMemo(() => {
		if (sortKey === null) return rows as Row[]
		const compare = (a: Row, b: Row) => compareValues(a[sortKey], b[sortKey], sortDir)
		if (pinned === undefined) return [...rows].sort(compare)
		const top: Row[] = []
		const rest: Row[] = []
		for (const row of rows) (pinned(row) ? top : rest).push(row)
		return [...top.sort(compare), ...rest.sort(compare)]
	}, [rows, sortKey, sortDir, pinned])

	return { sorted, sortKey, sortDir, handleSort }
}
