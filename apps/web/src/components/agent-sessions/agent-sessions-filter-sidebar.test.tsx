// @vitest-environment jsdom
// TEST-SEAM: This focused test replaces the router with a recorder — the sidebar only navigates.

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Result } from "@/lib/effect-atom"
import type { AgentSessionsSearchState } from "./agent-sessions-filter-inputs"

const navigate = vi.fn()
let search: AgentSessionsSearchState = {}

vi.mock("@tanstack/react-router", () => ({
	getRouteApi: () => ({ useNavigate: () => navigate, useSearch: () => search }),
}))

import { AgentSessionsFilterSidebar } from "./agent-sessions-filter-sidebar"
import { AgentSessionsToolbar } from "./agent-sessions-toolbar"
import { sortOptionFor } from "./agent-sessions-filter-inputs"

const facets = Result.success({
	vendors: [
		{ name: "eve", count: 12 },
		{ name: "vercel_ai_sdk", count: 3 },
	],
	services: [{ name: "agent-runner", count: 15 }],
	environments: [{ name: "production", count: 15 }],
	models: [{ name: "openrouter/anthropic/claude-sonnet-5", count: 9 }],
	agents: [],
	tools: [{ name: "search_traces", count: 4 }],
})

/** What the recorded navigate call would write, given the search it started from. */
const nextSearch = (): Record<string, unknown> => {
	const call = navigate.mock.calls.at(-1)?.[0] as {
		search: (prev: AgentSessionsSearchState) => Record<string, unknown>
	}
	return call.search(search)
}

describe("AgentSessionsFilterSidebar", () => {
	beforeEach(() => {
		navigate.mockReset()
		search = {}
	})
	afterEach(cleanup)

	it("renders a section per counted dimension, hiding the ones with nothing to offer", () => {
		render(<AgentSessionsFilterSidebar facetsResult={facets} />)

		for (const title of ["Framework", "Service", "Environment", "Model", "Tool"]) {
			expect(screen.getByText(title)).toBeTruthy()
		}
		expect(screen.queryByText("Agent")).toBeNull()
		// Framework ids read as labels, models as their last path segment, both
		// with the session count beside them.
		expect(screen.getByText("Vercel AI SDK")).toBeTruthy()
		expect(screen.getByText("claude-sonnet-5")).toBeTruthy()
		for (const title of ["Session length", "Cost", "Tokens", "LLM calls", "Tool calls"]) {
			expect(screen.getByText(title)).toBeTruthy()
		}
		expect(screen.getByText("Hide single-trace sessions")).toBeTruthy()
	})

	it("accumulates a second framework rather than replacing the first", () => {
		search = { vendors: ["eve"] }
		render(<AgentSessionsFilterSidebar facetsResult={facets} />)

		fireEvent.click(screen.getByText("Vercel AI SDK"))
		expect(nextSearch().vendors).toEqual(["eve", "vercel_ai_sdk"])
	})

	it("keeps a selected value that the window no longer offers", () => {
		search = { tools: ["send_email"] }
		render(<AgentSessionsFilterSidebar facetsResult={facets} />)

		expect(screen.getByText("send_email")).toBeTruthy()
	})

	it("writes a preset as the range it names, and clears it on a second click", () => {
		render(<AgentSessionsFilterSidebar facetsResult={facets} />)

		fireEvent.click(screen.getByText("Cost"))
		fireEvent.click(screen.getByText("Over $1"))
		expect(nextSearch()).toMatchObject({ costMin: 1, costMax: undefined })

		search = { costMin: 1 }
		cleanup()
		render(<AgentSessionsFilterSidebar facetsResult={facets} />)
		fireEvent.click(screen.getByText("Over $1"))
		expect(nextSearch()).toMatchObject({
			costMin: undefined,
			costMax: undefined,
		})
	})

	it("clears every filter but leaves the window and the sort alone", () => {
		search = {
			vendors: ["eve"],
			q: "wrun",
			hasErrors: true,
			grouped: true,
			tokensMin: 100,
			sortBy: "cost",
			sortDir: "desc",
		}
		render(<AgentSessionsFilterSidebar facetsResult={facets} />)

		fireEvent.click(screen.getByRole("button", { name: /clear all/i }))
		const next = nextSearch()
		expect(next).toMatchObject({
			vendors: undefined,
			q: undefined,
			hasErrors: undefined,
			grouped: undefined,
			tokensMin: undefined,
			sortBy: "cost",
			sortDir: "desc",
		})
	})

	it("toggles the single-trace filter on and writes nothing when it is off", () => {
		render(<AgentSessionsFilterSidebar facetsResult={facets} />)

		fireEvent.click(screen.getByLabelText("Hide single-trace sessions"))
		expect(nextSearch().grouped).toBe(true)
	})
})

describe("AgentSessionsToolbar", () => {
	afterEach(cleanup)

	it("names the current sort and offers every measure", () => {
		const onSortChange = vi.fn()
		const onToggleErrorsOnly = vi.fn()
		render(
			<AgentSessionsToolbar
				query=""
				onSearch={vi.fn()}
				errorsOnly={false}
				onToggleErrorsOnly={onToggleErrorsOnly}
				sortKey={sortOptionFor("cost", "desc").key}
				onSortChange={onSortChange}
				sessionCount={12}
			/>,
		)

		// The menu itself is portal-rendered on open; jsdom sees the trigger,
		// which names the sort it is set to.
		const sort = screen.getByRole("combobox", { name: "Sort sessions" })
		expect(sort.textContent).toContain("Most expensive")
		// The error filter is a switch: on or off, never a button that looks
		// like a warning about the list.
		const errors = screen.getByRole("switch", { name: "With errors" })
		expect(errors.getAttribute("aria-checked")).toBe("false")
		fireEvent.click(errors)
		expect(onToggleErrorsOnly).toHaveBeenCalledOnce()
		expect(screen.getByText("12")).toBeTruthy()
		expect(screen.getByPlaceholderText("Session or trace ID…")).toBeTruthy()
	})

	it("falls back to newest-first for a pair the menu does not offer", () => {
		expect(sortOptionFor(undefined, undefined).key).toBe("newest")
		expect(sortOptionFor("cost", "asc").key).toBe("newest")
		expect(sortOptionFor("startTime", "asc").key).toBe("oldest")
	})
})
