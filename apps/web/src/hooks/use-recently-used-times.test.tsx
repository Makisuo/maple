// @vitest-environment jsdom

import { RECENTLY_USED_TIMES_STORAGE_KEY, type RecentTimeRange } from "@/atoms/recently-used-times-atoms"
import { Registry, RegistryContext } from "@/lib/effect-atom"
import { localStorageRuntime } from "@/lib/services/common/storage-runtime"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { useRecentlyUsedTimes } from "./use-recently-used-times"

const ranges = Array.from(
	{ length: 6 },
	(_, index): RecentTimeRange => ({
		label: `Range ${index + 1}`,
		value: `${index + 1}h`,
		startTime: `2026-07-17 0${index}:00:00`,
		endTime: `2026-07-17 0${index + 1}:00:00`,
	}),
)

function createWrapper() {
	const registry = Registry.make()
	registry.mount(localStorageRuntime)

	return function Wrapper({ children }: { children: ReactNode }) {
		return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
	}
}

function Probe() {
	const { recentTimes, addRecentTime, clearRecentTimes } = useRecentlyUsedTimes()
	return (
		<div>
			<div data-testid="values">{recentTimes.map((range) => range.value).join(",")}</div>
			{ranges.map((range) => (
				<button key={range.value} onClick={() => addRecentTime(range)}>
					add-{range.value}
				</button>
			))}
			<button onClick={clearRecentTimes}>clear</button>
		</div>
	)
}

describe("useRecentlyUsedTimes", () => {
	beforeEach(() => window.localStorage.removeItem(RECENTLY_USED_TIMES_STORAGE_KEY))
	afterEach(cleanup)

	it("persists, deduplicates, and caps recent ranges through Atom.kvs", async () => {
		render(<Probe />, { wrapper: createWrapper() })

		for (const range of ranges) {
			fireEvent.click(screen.getByRole("button", { name: `add-${range.value}` }))
		}
		fireEvent.click(screen.getByRole("button", { name: "add-3h" }))

		await waitFor(() => {
			expect(screen.getByTestId("values").textContent).toBe("3h,6h,5h,4h,2h")
		})

		const stored = JSON.parse(
			window.localStorage.getItem(RECENTLY_USED_TIMES_STORAGE_KEY) ?? "[]",
		) as RecentTimeRange[]
		expect(stored.map((range) => range.value)).toEqual(["3h", "6h", "5h", "4h", "2h"])

		fireEvent.click(screen.getByRole("button", { name: "clear" }))
		await waitFor(() => expect(screen.getByTestId("values").textContent).toBe(""))
	})
})
