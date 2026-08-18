// @vitest-environment jsdom

/**
 * The two properties that let a dashboard render on a page with no session.
 *
 * Both are seams rather than features, and both fail silently if broken — a
 * thrown context error only on the share route, or an edit menu quietly
 * appearing on a public link — so they are asserted here rather than left to a
 * manual pass over the shared page.
 */
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { vi } from "vitest"

import { DashboardGrid } from "@/components/dashboard-builder/canvas/dashboard-canvas"
import { GRID_TIERS } from "@/components/dashboard-builder/canvas/grid-breakpoints"
import { ShareWidgetStatesProvider, SharedWidgetRenderer } from "@/components/share/shared-widget-renderer"
import type { ShareWidget } from "@/hooks/use-share-dashboard"

beforeAll(() => {
	class noop {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	vi.stubGlobal("ResizeObserver", noop)
})

afterEach(cleanup)

const widget = (id: string): ShareWidget => ({
	id,
	visualization: "stat",
	display: { title: "Requests" },
	layout: { x: 0, y: 0, w: 6, h: 4 },
	dataSource: { kind: "query" },
})

describe("DashboardGrid outside a dashboard", () => {
	// The share page and the full-screen board have no mutation store, so
	// `DashboardActionsProvider` is never mounted above them. Before the optional
	// read this threw on render and took the whole route with it.
	it("renders with no DashboardActionsProvider above it", () => {
		expect(() =>
			render(
				<ShareWidgetStatesProvider states={{}}>
					<DashboardGrid
						widgets={[widget("w-1")]}
						width={1200}
						tier={GRID_TIERS[0]}
						editable={false}
						renderWidget={SharedWidgetRenderer}
					/>
				</ShareWidgetStatesProvider>,
			),
		).not.toThrow()
	})

	// `containerPadding` defaults to `margin`, which indented the first column by
	// a gutter's width — so tiles sat 12px inside everything stacked above them
	// (section headers, the share page's time-range label and refresh controls).
	// The gutter belongs between tiles; the surrounding layout owns the outer
	// padding. Asserted on the inline position because that is the only place the
	// offset exists — there is no class to look for.
	it("starts the first column flush with its container, not a gutter inside it", () => {
		const [tier] = GRID_TIERS
		const { container } = render(
			<ShareWidgetStatesProvider states={{}}>
				<DashboardGrid
					widgets={[widget("w-1")]}
					width={1200}
					tier={tier}
					editable={false}
					renderWidget={SharedWidgetRenderer}
				/>
			</ShareWidgetStatesProvider>,
		)

		const item = container.querySelector<HTMLElement>(".react-grid-item")
		expect(item).not.toBeNull()
		// x only. y deliberately keeps `margin[1]`, so asserting on the whole
		// transform would pass for the wrong reason (or fail for a good one).
		const [x, y] = (item?.style.transform ?? "").match(/-?\d+(\.\d+)?px/g) ?? []
		expect(x).toBe("0px")
		expect(y).toBe(`${tier.margin[1]}px`)
	})
})

describe("SharedWidgetRenderer", () => {
	// `WidgetActionsProvider` always defines `remove` and offers `createAlert`,
	// and `WidgetShell` shows its menu in view mode whenever `createAlert` exists
	// — so mounting one here would put edit affordances and links into authed
	// routes on a page served without a session. This is the guard against
	// someone later "fixing" the missing provider.
	// The state a tile receives is already renderer-ready: `useShareWidgetData`
	// unwraps the server's envelope and applies the stored transform through the
	// same `toReadyWidgetData` the signed-in hook uses. The renderer must draw
	// that state as-is — a second transform pass here is exactly how the two
	// paths drifted before (the renderer reshaped, the hook did not, and every
	// chart on a shared board got an object where an array belongs).
	it("draws the renderer-ready state it is handed, without reshaping it", () => {
		const stat: ShareWidget = {
			...widget("w-stat"),
			dataSource: { kind: "query", transform: { reduceToValue: { field: "hits", aggregate: "sum" } } },
		}

		render(
			<ShareWidgetStatesProvider states={{ "w-stat": { status: "ready", data: 42 } }}>
				<SharedWidgetRenderer widget={stat} />
			</ShareWidgetStatesProvider>,
		)

		expect(screen.getByText("42")).toBeTruthy()
		expect(screen.queryByText("—")).toBeNull()
	})

	it("exposes no widget actions at all", () => {
		render(
			<ShareWidgetStatesProvider states={{}}>
				<SharedWidgetRenderer widget={widget("w-1")} />
			</ShareWidgetStatesProvider>,
		)

		expect(screen.queryByRole("button")).toBeNull()
		expect(screen.queryByText(/create alert/i)).toBeNull()
		expect(screen.queryByText(/remove/i)).toBeNull()
	})
})
