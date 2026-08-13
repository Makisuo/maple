import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { ApiKeyId } from "../../primitives"
import { publicHttpErrorPolicy } from "../error-policy"
import { ApiKeyNotFoundError, ApiKeyPersistenceError } from "../api-keys"
import { IngestKeyEncryptionError } from "../ingest-keys"
import {
	QueryEngineExecutionError,
	QueryEngineResultMismatchError,
	QueryEngineTimeoutError,
	QueryEngineValidationError,
} from "../query-engine"
import {
	WarehouseMalformedQueryError,
	WarehouseQuotaExceededError,
	WarehouseResultDecodeError,
	WarehouseSchemaDriftError,
	WarehouseUpstreamError,
	WarehouseValidationError,
} from "../warehouse-errors"
import { publicError } from "./public-error"

const keyId = Schema.decodeUnknownSync(ApiKeyId)("0f8fad5b-d9cb-469f-a165-70867728950e")

describe("HttpTaggedError public body", () => {
	it("encodes the original error directly with its exact tag", () => {
		const error = new ApiKeyNotFoundError({ keyId, message: `missing ${keyId}` })
		const encoded = Schema.encodeSync(publicError(ApiKeyNotFoundError))(error)

		expect(encoded.error._tag).toBe(error._tag)
		expect(encoded.error.type).toBe("not_found_error")
		expect(encoded.error.code).toBe("api_key_not_found")
		expect(publicHttpErrorPolicy(error).status).toBe(404)
	})

	it("redacts private internal messages", () => {
		const error = new ApiKeyPersistenceError({
			message: "postgres://user:secret@internal SELECT * FROM api_keys",
		})

		expect(JSON.stringify(error.error)).not.toContain("postgres://")
		expect(error.error._tag).toBe("@maple/http/errors/ApiKeyPersistenceError")
		expect(publicHttpErrorPolicy(error).status).toBe(503)
	})

	it("keeps Maple defects distinct from dependency outages", () => {
		const error = new IngestKeyEncryptionError({ message: "KMS key material leaked here" })

		expect(error.error._tag).toBe(error._tag)
		expect(error.error.code).toBe("ingest_key_encryption_failed")
		expect(error.error.message).not.toContain(error.message)
		expect(publicHttpErrorPolicy(error).status).toBe(500)
	})

	it("preserves warehouse validation, quota, outage, and Maple-fault statuses", () => {
		const validation = new WarehouseValidationError({
			pipeName: "sqlQuery",
			message: "start_time is after end_time",
		})
		const quota = new WarehouseQuotaExceededError({
			pipeName: "listTraces",
			message: "TIMEOUT_EXCEEDED",
			setting: "max_execution_time",
		})
		const upstream = new WarehouseUpstreamError({
			pipeName: "listTraces",
			message: "521 error",
			upstreamStatus: 521,
		})
		const malformed = new WarehouseMalformedQueryError({
			pipeName: "traces_timeseries",
			message: "NO_COMMON_TYPE",
		})

		expect(publicHttpErrorPolicy(validation).status).toBe(400)
		expect(publicHttpErrorPolicy(quota).status).toBe(429)
		expect(publicHttpErrorPolicy(upstream).status).toBe(503)
		expect(publicHttpErrorPolicy(malformed).status).toBe(500)
	})

	it("owns warehouse remediation copy without exposing diagnostics", () => {
		const error = new WarehouseSchemaDriftError({
			pipeName: "service_overview",
			message: "Unknown column SecretCustomerColumn",
		})

		expect(error.error.message).toContain("schema apply")
		expect(error.error.message).not.toContain("SecretCustomerColumn")
		expect(publicHttpErrorPolicy(error).status).toBe(502)
	})

	it("distinguishes cluster schema drift from Maple result decoding failures", () => {
		const error = new WarehouseResultDecodeError({
			pipeName: "service_overview",
			message: "Secret wire-format mismatch",
		})

		expect(error.error).toMatchObject({
			_tag: "@maple/http/errors/WarehouseResultDecodeError",
			code: "warehouse_result_decode_failed",
			recovery: "contact_support",
		})
		expect(error.error.message).not.toContain("Secret wire-format mismatch")
	})

	it("serializes query-engine failures directly", () => {
		const validation = new QueryEngineValidationError({ message: "invalid aggregation", details: [] })
		const execution = new QueryEngineExecutionError({ message: "execution failed" })
		const timeout = new QueryEngineTimeoutError({ message: "timed out" })
		const mismatch = new QueryEngineResultMismatchError({
			message: "expected timeseries, got scalar",
			expectedKind: "timeseries",
			actualKind: "scalar",
		})

		expect(publicHttpErrorPolicy(validation).status).toBe(400)
		expect(publicHttpErrorPolicy(execution).status).toBe(502)
		expect(publicHttpErrorPolicy(timeout).status).toBe(504)
		expect(publicHttpErrorPolicy(mismatch).status).toBe(500)
	})
})
