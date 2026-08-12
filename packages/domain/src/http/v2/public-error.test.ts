import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { ApiKeyId } from "../../primitives"
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
	WarehouseSchemaDriftError,
	WarehouseUpstreamError,
	WarehouseValidationError,
} from "../warehouse-errors"
import {
	V2ApiError,
	V2GatewayTimeoutError,
	V2InvalidRequestError,
	V2NotFoundError,
	V2RateLimitError,
	V2ServiceUnavailableError,
	V2UpstreamError,
} from "./errors"
import { toV2Error } from "./public-error"

const keyId = Schema.decodeUnknownSync(ApiKeyId)("0f8fad5b-d9cb-469f-a165-70867728950e")

describe("toV2Error", () => {
	it("preserves the domain tag and uses the error's declared status", () => {
		const error = new ApiKeyNotFoundError({ keyId, message: `missing ${keyId}` })
		const mapped = toV2Error(error)

		expect(mapped).toBeInstanceOf(V2NotFoundError)
		expect(mapped.error._tag).toBe(error._tag)
		expect(mapped.error.code).toBe("api_key_not_found")
	})

	it("redacts private internal messages", () => {
		const mapped = toV2Error(
			new ApiKeyPersistenceError({
				message: "postgres://user:secret@internal SELECT * FROM api_keys",
			}),
		)

		expect(mapped).toBeInstanceOf(V2ServiceUnavailableError)
		expect(JSON.stringify(mapped.error)).not.toContain("postgres://")
		expect(mapped.error._tag).toBe("@maple/http/errors/ApiKeyPersistenceError")
	})

	it("keeps Maple defects distinct from dependency outages", () => {
		const error = new IngestKeyEncryptionError({ message: "KMS key material leaked here" })
		const mapped = toV2Error(error)

		expect(mapped).toBeInstanceOf(V2ApiError)
		expect(mapped.error._tag).toBe(error._tag)
		expect(mapped.error.code).toBe("ingest_key_encryption_failed")
		expect(mapped.error.message).not.toContain(error.message)
	})

	it("preserves warehouse validation, quota, outage, and Maple-fault statuses", () => {
		expect(
			toV2Error(
				new WarehouseValidationError({
					pipeName: "sqlQuery",
					message: "start_time is after end_time",
				}),
			),
		).toBeInstanceOf(V2InvalidRequestError)
		expect(
			toV2Error(
				new WarehouseQuotaExceededError({
					pipeName: "listTraces",
					message: "TIMEOUT_EXCEEDED",
					setting: "max_execution_time",
				}),
			),
		).toBeInstanceOf(V2RateLimitError)
		expect(
			toV2Error(
				new WarehouseUpstreamError({
					pipeName: "listTraces",
					message: "521 error",
					upstreamStatus: 521,
				}),
			),
		).toBeInstanceOf(V2ServiceUnavailableError)
		expect(
			toV2Error(
				new WarehouseMalformedQueryError({
					pipeName: "traces_timeseries",
					message: "NO_COMMON_TYPE",
				}),
			),
		).toBeInstanceOf(V2ApiError)
	})

	it("owns warehouse remediation copy without exposing diagnostics", () => {
		const mapped = toV2Error(
			new WarehouseSchemaDriftError({
				pipeName: "service_overview",
				message: "Unknown column SecretCustomerColumn",
			}),
		)

		expect(mapped).toBeInstanceOf(V2UpstreamError)
		expect(mapped.error.message).toContain("schema apply")
		expect(mapped.error.message).not.toContain("SecretCustomerColumn")
	})

	it("serializes query-engine failures directly", () => {
		expect(
			toV2Error(new QueryEngineValidationError({ message: "invalid aggregation", details: [] })),
		).toBeInstanceOf(V2InvalidRequestError)
		expect(toV2Error(new QueryEngineExecutionError({ message: "execution failed" }))).toBeInstanceOf(
			V2UpstreamError,
		)
		expect(toV2Error(new QueryEngineTimeoutError({ message: "timed out" }))).toBeInstanceOf(
			V2GatewayTimeoutError,
		)
		expect(
			toV2Error(
				new QueryEngineResultMismatchError({
					message: "expected timeseries, got scalar",
					expectedKind: "timeseries",
					actualKind: "scalar",
				}),
			),
		).toBeInstanceOf(V2ApiError)
	})
})
