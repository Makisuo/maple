import { describe, expect, it } from "vitest"

import { parseLogSearch } from "./log-search-query"

const TRACE = "4b1f2c3d4e5f60718293a4b5c6d7e8f9"

describe("parseLogSearch", () => {
	it("is nothing when the box is empty", () => {
		expect(parseLogSearch(undefined)).toBeUndefined()
		expect(parseLogSearch("   ")).toBeUndefined()
	})

	it("reads 32 hex characters as a trace id, lowercased", () => {
		expect(parseLogSearch(` ${TRACE.toUpperCase()} `)).toEqual({ kind: "trace", traceId: TRACE })
	})

	it("lifts the trace id out of a traceparent header", () => {
		expect(parseLogSearch(`00-${TRACE}-00f067aa0ba902b7-01`)).toEqual({
			kind: "trace",
			traceId: TRACE,
		})
	})

	it("treats anything else as message text", () => {
		expect(parseLogSearch("conn reset")).toEqual({ kind: "text", text: "conn reset" })
		// 31 hex characters is not a trace id.
		expect(parseLogSearch(TRACE.slice(1))).toEqual({ kind: "text", text: TRACE.slice(1) })
	})

	it("quotes force a text search for an id-shaped string", () => {
		expect(parseLogSearch(`"${TRACE}"`)).toEqual({ kind: "text", text: TRACE })
	})

	it("ignores empty quotes rather than searching for nothing", () => {
		expect(parseLogSearch('""')).toBeUndefined()
	})
})
