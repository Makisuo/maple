import { describe, expect, it } from "@effect/vitest"
import {
	WAREHOUSE_ERROR_TAGS,
	warehouseErrorCode,
	warehouseErrorStatus,
	presentWarehouseError,
	isWarehouseErrorTag,
} from "./warehouse-error-meta"
import { warehouseHttpErrors } from "./warehouse-errors"

describe("warehouse error meta", () => {
	it("derives one tag per error class", () => {
		expect(WAREHOUSE_ERROR_TAGS).toHaveLength(warehouseHttpErrors.length)
		expect(new Set(WAREHOUSE_ERROR_TAGS).size).toBe(warehouseHttpErrors.length)
	})

	it("covers every derived tag in the status map", () => {
		for (const tag of WAREHOUSE_ERROR_TAGS) {
			expect(warehouseErrorStatus.get(tag), tag).toBeTypeOf("number")
			expect(isWarehouseErrorTag(tag)).toBe(true)
		}
	})

	it("gives every tag a non-generic presentation", () => {
		for (const tag of WAREHOUSE_ERROR_TAGS) {
			const presented = presentWarehouseError({ _tag: tag, message: "boom" })
			expect(presented.title, tag).not.toBe("")
			expect(presented.title, tag).not.toBe("Something went wrong")
			expect(presented.description, tag).not.toBe("")
		}
	})

	it("unique codes per tag", () => {
		const codes = WAREHOUSE_ERROR_TAGS.map((tag) => warehouseErrorCode({ _tag: tag }))
		expect(new Set(codes).size).toBe(codes.length)
	})

	it("suppresses the schema-apply advice for decode-kind drift", () => {
		const cluster = presentWarehouseError({
			_tag: "@maple/http/errors/WarehouseSchemaDriftError",
			message: "Missing column SampleRate",
		})
		expect(cluster.description).toContain("schema apply")

		const decode = presentWarehouseError({
			_tag: "@maple/http/errors/WarehouseSchemaDriftError",
			message: "Compiled query row 0 did not match its declared output schema",
			kind: "decode",
		})
		expect(decode.description).not.toContain("schema apply")
		expect(decode.description).toContain("Maple bug")
	})

	it("re-sniffs embedded statuses out of generic query failures", () => {
		const auth = presentWarehouseError({
			_tag: "@maple/http/errors/WarehouseQueryError",
			message: "Request failed, response status code: 403",
		})
		expect(auth.title).toBe("Database rejected our credentials")

		const upstream = presentWarehouseError({
			_tag: "@maple/http/errors/WarehouseQueryError",
			message: "503 Service Temporarily Unavailable",
		})
		expect(upstream.title).toBe("Database is temporarily unavailable")
	})
})
