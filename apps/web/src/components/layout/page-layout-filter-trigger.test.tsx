// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PageLayout } from "@maple/ui/components/ui/page-layout"

// The mobile filter trigger sits in the page header while the sidebar it opens sits in the body,
// so it cannot see the sidebar as a child. Before this was tracked in context, the trigger rendered
// on every narrow-viewport page — including ones with no filters, where tapping it opened nothing.

function setViewport(collapsed: boolean) {
	// `useMediaQuery("max-lg")` — collapsed means the sidebar has become a sheet.
	vi.stubGlobal(
		"matchMedia",
		(query: string) =>
			({
				matches: collapsed,
				media: query,
				onchange: null,
				addEventListener: () => {},
				removeEventListener: () => {},
				addListener: () => {},
				removeListener: () => {},
				dispatchEvent: () => false,
			}) as unknown as MediaQueryList,
	)
}

const trigger = () => screen.queryByRole("button", { name: "Open filters" })

const Shell = ({ withFilters }: { withFilters: boolean }) => (
	<PageLayout.Root>
		<PageLayout.FilterSidebarTrigger>
			<button type="button" aria-label="Open filters" />
		</PageLayout.FilterSidebarTrigger>
		<PageLayout.Body>
			{withFilters ? <PageLayout.FilterSidebar>filters</PageLayout.FilterSidebar> : null}
			<PageLayout.Content>
				<PageLayout.ScrollArea>body</PageLayout.ScrollArea>
			</PageLayout.Content>
		</PageLayout.Body>
	</PageLayout.Root>
)

afterEach(cleanup)
beforeEach(() => vi.unstubAllGlobals())

describe("PageLayout.FilterSidebarTrigger", () => {
	it("stays hidden on a narrow viewport when the page composes no filter sidebar", () => {
		setViewport(true)
		render(<Shell withFilters={false} />)
		expect(trigger()).toBeNull()
	})

	it("renders on a narrow viewport when a filter sidebar is mounted", () => {
		setViewport(true)
		render(<Shell withFilters />)
		expect(trigger()).not.toBeNull()
	})

	it("stays hidden on a wide viewport, where the sidebar is inline", () => {
		setViewport(false)
		render(<Shell withFilters />)
		expect(trigger()).toBeNull()
	})

	it("disappears again if the filter sidebar unmounts", () => {
		setViewport(true)
		const view = render(<Shell withFilters />)
		expect(trigger()).not.toBeNull()

		view.rerender(<Shell withFilters={false} />)
		expect(trigger()).toBeNull()
	})
})
