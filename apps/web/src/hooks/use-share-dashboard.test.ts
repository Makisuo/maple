/**
 * The share transport, decoded.
 *
 * Payloads are built by running the real `redactForShare` over a stored-shaped
 * document rather than hand-typing a literal, so these tests fail if the server
 * projection and the client decoder ever stop agreeing — which is exactly the
 * drift that produced a flat, uniformly-sized shared board in the first place.
 */
import { describe, expect, it } from "vitest"
import { redactForShare } from "@maple/widgets/dashboard"

import { decodeShare } from "@/hooks/use-share-dashboard"

const storedDocument = {
	id: "dash-1",
	name: "Ops",
	timeRange: { type: "relative" as const, value: "12h" },
	widgets: [
		{
			id: "w-root",
			visualization: "stat",
			display: { title: "Requests" },
			layout: { x: 0, y: 0, w: 3, h: 4, minW: 2, maxH: 8 },
			dataSource: { kind: "raw_sql", sql: "SELECT 1", transform: { limit: 10 } },
		},
		{
			id: "w-grouped",
			visualization: "line",
			display: { title: "Latency" },
			layout: { x: 3, y: 0, w: 9, h: 4 },
			sectionId: "sec-1",
			tabId: "tab-1",
			timeRange: { type: "relative" as const, value: "7d" },
			dataSource: { kind: "query", resultShape: "timeseries", queries: [] },
		},
	],
	sections: [{ id: "sec-1", title: "Latency", tabs: [{ id: "tab-1", title: "Overview" }] }],
}

const resolvePayload = (document: unknown, scope: "dashboard" | "widget" = "dashboard") => ({
	mode: "public" as const,
	scope,
	dashboard: document,
	limits: { maxRangeSeconds: 86_400, maxListRangeSeconds: 3_600 },
	embeddable: false,
})

describe("decodeShare", () => {
	it("carries the placement the canvas lays out from", async () => {
		const share = await decodeShare(resolvePayload(redactForShare(storedDocument)))

		expect(share.dashboard.widgets[0]?.layout).toEqual({ x: 0, y: 0, w: 3, h: 4, minW: 2, maxH: 8 })
		expect(share.dashboard.widgets[1]).toMatchObject({
			sectionId: "sec-1",
			tabId: "tab-1",
			timeRange: { type: "relative", value: "7d" },
		})
		expect(share.dashboard.sections).toEqual([
			{ id: "sec-1", title: "Latency", tabs: [{ id: "tab-1", title: "Overview" }] },
		])
	})

	it("decodes a single-chart share, which carries no sections at all", async () => {
		const share = await decodeShare(resolvePayload(redactForShare(storedDocument, "w-grouped"), "widget"))

		expect(share.dashboard.widgets).toHaveLength(1)
		expect(share.dashboard.sections).toEqual([])
		// Lifted out of its group by the redaction seam, so there is nothing left
		// to place it against.
		expect(share.dashboard.widgets[0]?.sectionId).toBeUndefined()
	})

	// An older client reading a newer board must still draw something.
	// `widgetTypeFor` already decides what an unknown type falls back to; the
	// decoder must not pre-empt that by refusing the payload.
	it("accepts a visualization this build doesn't know", async () => {
		const document = redactForShare({
			...storedDocument,
			widgets: [{ ...storedDocument.widgets[0], visualization: "sankey-from-the-future" }],
		})

		const share = await decodeShare(resolvePayload(document))
		expect(share.dashboard.widgets[0]?.visualization).toBe("sankey-from-the-future")
	})

	it("ignores fields it doesn't model, so a newer server can add them", async () => {
		const document = { ...redactForShare(storedDocument), somethingNew: { nested: true } }

		const share = await decodeShare(resolvePayload(document))
		expect(share.dashboard.widgets).toHaveLength(2)
	})

	// The tiles are the dashboard; the grouping is only how they're arranged.
	it("renders ungrouped rather than failing when sections don't decode", async () => {
		const document = { ...redactForShare(storedDocument), sections: [{ nonsense: true }] }

		const share = await decodeShare(resolvePayload(document))
		expect(share.dashboard.sections).toEqual([])
		expect(share.dashboard.widgets).toHaveLength(2)
	})

	it("rejects a payload whose widgets have no placement", async () => {
		const document = {
			...redactForShare(storedDocument),
			widgets: [{ id: "w", visualization: "stat", display: {}, dataSource: { kind: "query" } }],
		}

		await expect(decodeShare(resolvePayload(document))).rejects.toThrow()
	})
})
