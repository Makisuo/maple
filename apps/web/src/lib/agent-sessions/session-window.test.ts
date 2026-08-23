import { describe, expect, it } from "vitest"

import { parseWarehouseDateTime } from "@maple/query-engine/datetime"

import {
	breadcrumbSessionId,
	buildBackToSessionsHref,
	resolveWindow,
} from "@/lib/agent-sessions/session-window"

const NOW_MS = Date.UTC(2026, 7, 19, 18, 0, 0)

describe("resolveWindow", () => {
	it("pads a minute either side of the hints the list row carried", () => {
		const window = resolveWindow("2026-08-19 12:00:00.000000000", "2026-08-19 12:30:00.000000000", NOW_MS)

		expect(window.startTime).toBe("2026-08-19 11:59:00")
		expect(window.endTime).toBe("2026-08-19 12:31:00")
	})

	it("still narrows the read when only the start hint is present", () => {
		const window = resolveWindow("2026-08-19 12:00:00.000000000", undefined, NOW_MS)

		expect(window.startTime).toBe("2026-08-19 11:59:00")
		expect(window.endTime).toBe("2026-08-19 12:01:00")
	})

	// An unusable `end` must not cost the reader a perfectly good `t`: falling all
	// the way back to the fixed look-back reads a window that need not contain the
	// session at all, and the page then claims it has no spans.
	it("keeps a valid start hint when the end hint is unparseable", () => {
		const window = resolveWindow("2026-08-19 12:00:00.000000000", "not-a-timestamp", NOW_MS)

		expect(window.startTime).toBe("2026-08-19 11:59:00")
		expect(window.endTime).toBe("2026-08-19 12:01:00")
	})

	it("falls back to a window ending now when there is no start hint", () => {
		const window = resolveWindow(undefined, undefined, NOW_MS)

		expect(parseWarehouseDateTime(window.endTime)).toBe(NOW_MS)
		expect(parseWarehouseDateTime(window.startTime)).toBeLessThan(NOW_MS)
	})

	it("treats an unparseable start hint as no hint at all", () => {
		expect(resolveWindow("not-a-timestamp", undefined, NOW_MS)).toEqual(
			resolveWindow(undefined, undefined, NOW_MS),
		)
	})
})

describe("breadcrumbSessionId", () => {
	it("leaves a short id alone", () => {
		expect(breadcrumbSessionId("sess-42")).toBe("sess-42")
	})

	it("elides a long id from the middle, keeping both ends", () => {
		expect(breadcrumbSessionId("wrun_01KZTEBCDEFGHIJKLMNOPQRSTUV")).toBe("wrun_01KZ…STUV")
	})
})

describe("buildBackToSessionsHref", () => {
	it("keeps the list's own search and drops the detail page's params", () => {
		const href = buildBackToSessionsHref("?vendorIds=eve&t=2026-08-19&end=2026-08-19&trace=abc&span=def")

		expect(href).toBe("/agent-sessions?vendorIds=eve")
	})

	it("returns the bare list route when nothing survives", () => {
		expect(buildBackToSessionsHref("?t=2026-08-19&trace=abc")).toBe("/agent-sessions")
	})
})
