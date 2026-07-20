import { describe, expect, it } from "vitest"
import {
	WarehouseAuthError,
	WarehouseClientError,
	WarehouseConfigError,
	WarehouseQueryError,
	WarehouseQuotaExceededError,
	WarehouseSchemaDriftError,
	WarehouseUpstreamError,
} from "@maple/domain/http"
import { cleanErrorMessage, mapWarehouseError, toWarehouseQueryError } from "./errors"

describe("mapWarehouseError", () => {
	describe("quota", () => {
		it("maps the execution-time code to a quota error", () => {
			const mapped = mapWarehouseError("testPipe", { message: "took too long", code: "159" })
			expect(mapped).toBeInstanceOf(WarehouseQuotaExceededError)
			expect(mapped).toMatchObject({ setting: "max_execution_time", pipeName: "testPipe" })
		})

		it("maps the memory code to a quota error", () => {
			const mapped = mapWarehouseError("testPipe", { message: "out of memory", code: "241" })
			expect(mapped).toBeInstanceOf(WarehouseQuotaExceededError)
			expect(mapped).toMatchObject({ setting: "max_memory_usage" })
		})
	})

	describe("auth", () => {
		it("classifies the auth ClickHouse type", () => {
			expect(mapWarehouseError("p", { message: "nope", type: "AUTHENTICATION_FAILED" })).toBeInstanceOf(
				WarehouseAuthError,
			)
		})

		it("classifies a 401 leaked in the message and keeps the status", () => {
			const mapped = mapWarehouseError("p", "Request failed with status 401")
			expect(mapped).toBeInstanceOf(WarehouseAuthError)
			expect((mapped as WarehouseAuthError).upstreamStatus).toBe(401)
		})

		it("classifies Tinybird's invalid-token workspace-not-found message", () => {
			const mapped = mapWarehouseError(
				"p",
				"invalid authentication token. Workspace not found, make sure you use the token host",
			)
			expect(mapped).toBeInstanceOf(WarehouseAuthError)
		})
	})

	describe("upstream", () => {
		it("classifies a 503 and extracts the upstream status", () => {
			const mapped = mapWarehouseError("p", "Request failed with status 503")
			expect(mapped).toBeInstanceOf(WarehouseUpstreamError)
			expect((mapped as WarehouseUpstreamError).upstreamStatus).toBe(503)
		})

		it("classifies a transient ClickHouse type", () => {
			expect(mapWarehouseError("p", { message: "blip", type: "SOCKET_TIMEOUT" })).toBeInstanceOf(
				WarehouseUpstreamError,
			)
		})

		it("classifies a bare timeout message", () => {
			expect(mapWarehouseError("p", "Timeout error")).toBeInstanceOf(WarehouseUpstreamError)
		})
	})

	describe("config", () => {
		it("classifies an unknown-database ClickHouse type", () => {
			expect(mapWarehouseError("p", { message: "x", type: "UNKNOWN_DATABASE" })).toBeInstanceOf(
				WarehouseConfigError,
			)
		})

		it("classifies an unknown-database message", () => {
			expect(mapWarehouseError("p", "Code: 81. unknown database 'foo'")).toBeInstanceOf(
				WarehouseConfigError,
			)
		})
	})

	describe("client", () => {
		it("classifies a SyntaxError", () => {
			expect(mapWarehouseError("p", new SyntaxError("Unexpected token < in JSON"))).toBeInstanceOf(
				WarehouseClientError,
			)
		})

		it("classifies a response-parse message", () => {
			expect(mapWarehouseError("p", "Failed to parse ClickHouse response")).toBeInstanceOf(
				WarehouseClientError,
			)
		})
	})

	describe("schema_drift", () => {
		it("classifies the unknown-identifier ClickHouse type", () => {
			expect(mapWarehouseError("p", { message: "x", type: "UNKNOWN_IDENTIFIER" })).toBeInstanceOf(
				WarehouseSchemaDriftError,
			)
		})

		it("classifies an unknown-identifier message", () => {
			expect(
				mapWarehouseError("p", "Unknown expression or function identifier 'SampleRate' in scope"),
			).toBeInstanceOf(WarehouseSchemaDriftError)
		})
	})

	it("defaults unrecognized errors to the generic query error", () => {
		const mapped = mapWarehouseError("p", "DB::Exception: Syntax error near FROM")
		expect(mapped).toBeInstanceOf(WarehouseQueryError)
		expect(mapped._tag).toBe("@maple/http/errors/WarehouseQueryError")
	})

	it("honors precedence: a transient 503 wins over schema-drift text in the same message", () => {
		expect(mapWarehouseError("p", "Request failed with status 503: No such column 'x'")).toBeInstanceOf(
			WarehouseUpstreamError,
		)
	})

	it("propagates the ClickHouse code and type, coercing a numeric code", () => {
		const mapped = mapWarehouseError("p", { message: "boom", code: 226, type: "SYNTAX_ERROR" })
		expect(mapped.clickhouseCode).toBe("226")
		expect(mapped.clickhouseType).toBe("SYNTAX_ERROR")
	})

	it("threads the original error into cause", () => {
		const raw = { message: "boom", type: "SYNTAX_ERROR" }
		expect(mapWarehouseError("p", raw).cause).toBe(raw)
	})
})

describe("cleanErrorMessage", () => {
	it("strips a leaked nginx HTML body", () => {
		const cleaned = cleanErrorMessage(
			"Request failed with status 503: <html><head><title>503 Service Temporarily Unavailable</title></head><body><center><h1>503</h1></center></body></html>",
		)
		expect(cleaned).not.toContain("<")
		expect(cleaned).toBe("Request failed with status 503")
	})

	it("trims a trailing colon", () => {
		expect(cleanErrorMessage("Request failed with status 500:")).toBe("Request failed with status 500")
	})

	it("falls back to the first 200 chars when cleaning empties the message", () => {
		const raw = `<html>${"x".repeat(300)}`
		expect(cleanErrorMessage(raw)).toBe(raw.slice(0, 200))
	})
})

describe("toWarehouseQueryError", () => {
	it("returns a cleaned generic WarehouseQueryError carrying the cause", () => {
		const cause = new Error("DB::Exception: boom  ")
		const mapped = toWarehouseQueryError("testPipe", cause)
		expect(mapped).toBeInstanceOf(WarehouseQueryError)
		expect(mapped.message).toBe("DB::Exception: boom")
		expect(mapped.pipeName).toBe("testPipe")
		expect(mapped.cause).toBe(cause)
	})
})
