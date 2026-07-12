import { describe, expect, it } from "vitest"
import { parseSqlCommenterTraceparent } from "./sqlcommenter"

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
const SPAN_ID = "b7ad6b7169203331"

describe("parseSqlCommenterTraceparent", () => {
	it("extracts trace context from a trailing SQLCommenter comment", () => {
		const sql = `SELECT * FROM songs WHERE id = ? /*traceparent='00-${TRACE_ID}-${SPAN_ID}-01'*/`
		expect(parseSqlCommenterTraceparent(sql)).toEqual({
			traceId: TRACE_ID,
			spanId: SPAN_ID,
			flags: "01",
			sampled: true,
		})
	})

	it("reads the unsampled flag (00)", () => {
		const sql = `SELECT 1 /*traceparent='00-${TRACE_ID}-${SPAN_ID}-00'*/`
		expect(parseSqlCommenterTraceparent(sql)?.sampled).toBe(false)
	})

	it("finds the comment alongside other sqlcommenter keys", () => {
		const sql = `SELECT 1 /*db_driver='clickhouse',traceparent='00-${TRACE_ID}-${SPAN_ID}-01',route='%2Fusers'*/`
		expect(parseSqlCommenterTraceparent(sql)?.traceId).toBe(TRACE_ID)
	})

	it("is tolerant of a URL-encoded value, extra whitespace, and uppercase hex", () => {
		const sql = `SELECT 1 /* traceparent = '00-${TRACE_ID.toUpperCase()}-${SPAN_ID.toUpperCase()}-01' */`
		expect(parseSqlCommenterTraceparent(sql)?.spanId).toBe(SPAN_ID)
	})

	it("returns null when there is no traceparent comment", () => {
		expect(parseSqlCommenterTraceparent("SELECT * FROM songs")).toBeNull()
		expect(parseSqlCommenterTraceparent("")).toBeNull()
		expect(parseSqlCommenterTraceparent(null)).toBeNull()
		expect(parseSqlCommenterTraceparent(undefined)).toBeNull()
	})

	it("rejects a malformed traceparent (wrong lengths / all-zero ids)", () => {
		expect(parseSqlCommenterTraceparent("SELECT 1 /*traceparent='00-tooshort-abc-01'*/")).toBeNull()
		expect(
			parseSqlCommenterTraceparent(
				`SELECT 1 /*traceparent='00-${"0".repeat(32)}-${SPAN_ID}-01'*/`,
			),
		).toBeNull()
		expect(
			parseSqlCommenterTraceparent(
				`SELECT 1 /*traceparent='00-${TRACE_ID}-${"0".repeat(16)}-01'*/`,
			),
		).toBeNull()
	})
})
