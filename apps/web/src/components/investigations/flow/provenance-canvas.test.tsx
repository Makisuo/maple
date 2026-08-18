// @vitest-environment jsdom
// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
/**
 * The canvas is only useful if you can click it, and for one release you could not.
 *
 * xyflow's node wrapper derives pointer-events from
 * `isSelectable || isDraggable || onNodeClick || onNodeMouse*` and stamps
 * `pointer-events: none` when every one of them is off — which is exactly how this
 * canvas is configured (`selectable: false`, `draggable: false`,
 * `elementsSelectable={false}`, no node mouse handlers). Every link on every node
 * was inert, silently, and nothing in the graph-shape tests could see it because
 * the DOM is where it happens.
 *
 * So these assertions are deliberately about rendered pointer-events and a real
 * dispatched click, not about the graph model.
 */
import type { ReactNode } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { V2Investigation } from "@maple/domain/http/v2"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

// A plain anchor stands in for the router's: what is under test is whether a
// click lands on the node or on the link inside it, and `closest("a")` cannot
// tell the difference. Mounting a real router here would only test TanStack.
vi.mock("@tanstack/react-router", () => ({
	Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
		<a href={to} {...props}>
			{children}
		</a>
	),
}))

import { ProvenanceCanvas } from "./provenance-canvas"

// SAFETY: This fixture mirrors the decoded investigation payload and uses fixed test-only identifiers.
const investigation = {
	id: "inv_YofPTrK9782DWwcnXhpcCw",
	status: "diagnosed",
	subject: {
		type: "incident",
		incident_kind: "error",
		incident_id: "einc_8Kd21mQr",
		issue_id: "iss_9dK1",
	},
	snapshot: {
		title: "Checkout timeouts after deploy 8f21c",
		scope: "checkout-api",
		status: "open",
		severity: "critical",
		facts: [],
		references: [],
		incidentStartedAt: "2026-08-01T14:02:00.000Z",
		incidentEndedAt: null,
		errorLabel: "CheckoutTimeoutError",
		occurrenceCount: 1284,
	},
	report: {
		summary: "checkout-api saturated its connection pool",
		suspectedCause: "Pool exhaustion in checkout-api",
		severityAssessment: "critical",
		affectedScope: "Checkout & payment capture",
		evidence: [],
		suggestedActions: ["Roll back deploy 8f21c", "Alert on pool_active / pool_max > 0.8"],
		confidence: "high",
	},
	seeded_by: "system",
	created_at: "2026-08-01T14:02:00.000Z",
	started_at: "2026-08-01T14:02:00.000Z",
	diagnosed_at: "2026-08-01T14:02:38.000Z",
	updated_at: "2026-08-01T14:02:38.000Z",
	lens_runs: [],
	validator: null,
	fanout: { state: "none", size: 0 },
} as never as V2Investigation

beforeAll(() => {
	// xyflow measures every node; jsdom ships neither observer.
	const noop = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	vi.stubGlobal("ResizeObserver", noop)
	vi.stubGlobal("DOMMatrixReadOnly", class {})
})

// This project runs vitest without `globals`, so testing-library never registers
// its own teardown — without this every `getByRole` after the first test matches
// two canvases.
afterEach(cleanup)

const renderCanvas = (onOpenAction = vi.fn(), subject: V2Investigation = investigation) => {
	render(<ProvenanceCanvas investigation={subject} openActionIndex={null} onOpenAction={onOpenAction} />)
	return onOpenAction
}

/** Mid-run: a fan in flight, no report, so both ghost columns are up. */
// SAFETY: This fixture starts from a decoded investigation and overrides fields with valid variants.
const running = {
	...investigation,
	status: "investigating",
	report: null,
	diagnosed_at: null,
	lens_runs: [
		{
			lensId: "deploy_correlation",
			status: "checking",
			verdict: "pending",
			claim: null,
			reason: null,
			progressNote: null,
			confidence: null,
			toolCount: 1,
			elapsedSeconds: 2.1,
			name: null,
			question: null,
			priority: null,
			deadlineHit: false,
		},
	],
	fanout: { state: "running", size: 1 },
} as never as V2Investigation

describe("ProvenanceCanvas", () => {
	/**
	 * The regression itself. Asserted on every node, not just the action ones: the
	 * issue node's link died of the same cause, and a fix that only rescued the
	 * column someone complained about would leave the other half broken.
	 */
	it("leaves its nodes able to receive a pointer", () => {
		renderCanvas()
		const nodes = document.querySelectorAll<HTMLElement>(".react-flow__node")
		expect(nodes.length).toBeGreaterThan(0)
		for (const node of nodes) {
			expect(node.style.pointerEvents).toBe("all")
		}
	})

	/**
	 * Two buttons per action on purpose: the card on the canvas, and its twin in
	 * the screen-reader outline. xyflow renders into a transformed pane whose tab
	 * order is layout order, so the outline is the keyboard route in — both have to
	 * reach the same panel, which is why this asserts on every match rather than
	 * disambiguating down to one.
	 */
	it("opens the detail panel for the action that was clicked", () => {
		const onOpenAction = renderCanvas()
		const buttons = screen.getAllByRole("button", { name: /Proposed action 02/ })
		expect(buttons).toHaveLength(2)
		for (const button of buttons) {
			onOpenAction.mockClear()
			fireEvent.click(button)
			expect(onOpenAction).toHaveBeenCalledWith(1)
		}
	})

	/**
	 * The action card and its call to action are nested, and the inner one has to
	 * win — otherwise "VIEW TRACES" opens a panel about viewing traces.
	 */
	it("leaves the call to action to its own link", () => {
		const onOpenAction = renderCanvas()
		fireEvent.click(screen.getByRole("link", { name: /CREATE ALERT/ }))
		expect(onOpenAction).not.toHaveBeenCalled()
	})

	/**
	 * The ghost actions column is a loading state, and a loading state that can be
	 * clicked, tabbed to, or read out as a real proposal is worse than none — the
	 * reader would go looking for an action nobody has proposed.
	 */
	it("renders the pending actions column as inert ghosts", () => {
		renderCanvas(vi.fn(), running)
		const ghosts = document.querySelectorAll(".react-flow__node-actionGhost")
		expect(ghosts).toHaveLength(2)
		for (const ghost of ghosts) {
			expect(ghost.querySelector("a")).toBeNull()
			expect(ghost.querySelector("button")).toBeNull()
		}
		expect(screen.queryByRole("button", { name: /Proposed action/ })).toBeNull()
		// Announced once, as pending — not as two anonymous proposals.
		expect(screen.getByText("Proposed actions pending")).toBeTruthy()
	})
})
