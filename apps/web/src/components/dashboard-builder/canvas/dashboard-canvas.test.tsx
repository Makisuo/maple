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
})

describe("SharedWidgetRenderer", () => {
	// `WidgetActionsProvider` always defines `remove` and offers `createAlert`,
	// and `WidgetShell` shows its menu in view mode whenever `createAlert` exists
	// — so mounting one here would put edit affordances and links into authed
	// routes on a page served without a session. This is the guard against
	// someone later "fixing" the missing provider.
	// The server returns rows and the stored transform is what collapses them.
	// It reaches the client precisely because the redaction seam keeps it, so a
	// share that never applies it renders every stat as an em dash — which is
	// what shipped. Asserted on the rendered number, not on the call, because
	// the em dash is the symptom a reader actually sees.
	it("applies the stored transform, so a stat reduces to a single value", () => {
		const stat: ShareWidget = {
			...widget("w-stat"),
			dataSource: { kind: "query", transform: { reduceToValue: { field: "hits", aggregate: "sum" } } },
		}

		render(
			<ShareWidgetStatesProvider
				states={{
					"w-stat": { status: "ready", data: [{ hits: 40 }, { hits: 2 }] },
				}}
			>
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
