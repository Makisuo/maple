import { describe, expect, it } from "vitest"
import {
	PixelBracketsCurlyIcon,
	PixelNodesIcon,
	PixelTriangleWarningIcon,
	PixelWindowIcon,
} from "@/components/icons"
import { eventVisual, splitUrl, type EventRow } from "./session-events-panel"

const row = (overrides: Partial<EventRow>): EventRow => ({
	timestamp: "2026-08-23 10:00:00",
	type: "navigation",
	url: "",
	traceId: null,
	level: "",
	message: "",
	targetSelector: "",
	targetText: "",
	netMethod: "",
	netUrl: "",
	netStatus: 0,
	netDurationMs: 0,
	errorStack: "",
	...overrides,
})

describe("splitUrl", () => {
	it("leads with the path and trails with the host", () => {
		expect(splitUrl("https://superwall.com/docs/quickstart?ref=x")).toEqual({
			lead: "/docs/quickstart?ref=x",
			trail: "superwall.com",
		})
	})

	it("keeps an unparseable value whole rather than dropping it", () => {
		expect(splitUrl("not a url")).toEqual({ lead: "not a url", trail: "" })
	})
})

describe("eventVisual", () => {
	// The gateway's closed type set writes `navigation`; the panel used to switch
	// on `nav`, so every page view fell through to the default branch and printed
	// "NAVIGATION" across the URL beside it.
	it("recognizes the gateway's `navigation` type", () => {
		const visual = eventVisual(row({ type: "navigation", url: "https://superwall.com/pricing" }))
		expect(visual.Icon).toBe(PixelWindowIcon)
		expect(visual.lead).toBe("/pricing")
		expect(visual.trail).toBe("superwall.com")
	})

	it("prefixes a request with its method", () => {
		const visual = eventVisual(
			row({ type: "network", netMethod: "GET", netUrl: "https://radar.snitcher.com/v1/id" }),
		)
		expect(visual.Icon).toBe(PixelNodesIcon)
		expect(visual.lead).toBe("GET /v1/id")
		expect(visual.trail).toBe("radar.snitcher.com")
	})

	it("tones a failed request as an error", () => {
		expect(eventVisual(row({ type: "network", netStatus: 503 })).tone).toContain("destructive")
		expect(eventVisual(row({ type: "network", netStatus: 200 })).tone).not.toContain("destructive")
	})

	it("falls back without pretending to know the kind", () => {
		const visual = eventVisual(row({ type: "input", message: "typed" }))
		expect(visual.Icon).toBe(PixelBracketsCurlyIcon)
		expect(visual.lead).toBe("typed")
	})

	it("marks errors with the warning glyph", () => {
		expect(eventVisual(row({ type: "error", message: "boom" })).Icon).toBe(PixelTriangleWarningIcon)
	})
})
