import { beforeEach, describe, expect, it } from "vitest"
import { WarehouseQuotaExceededError } from "@maple/domain/http"
import { HttpClientError, HttpClientRequest } from "effect/unstable/http"
import { apiBaseUrl } from "@/lib/services/common/api-base-url"
import {
	noteReachable,
	noteUnreachable,
	originOf,
	PEER_OUTAGE_GRACE_MS,
} from "@/lib/services/common/peer-reachability"
import {
	WarehouseDecodeError,
	WarehouseQueryError,
	WarehouseUnreachableError,
	normalizeWarehouseError,
} from "./effect-utils"

describe("normalizeWarehouseError", () => {
	it("preserves a v2 error envelope", () => {
		const quota = new WarehouseQuotaExceededError({
			message: "internal",
			pipeName: "getReplayEvents",
			setting: "max_execution_time",
		})
		const error = {
			error: quota.error,
		}
		expect(normalizeWarehouseError("getReplayEvents", error)).toBe(error)
	})

	it("preserves self-describing backend and local warehouse errors", () => {
		const backend = new WarehouseQuotaExceededError({
			message: "internal",
			pipeName: "query",
			setting: "max_memory_usage",
		})
		const local = new WarehouseDecodeError({ operation: "decode", message: "invalid input" })
		expect(normalizeWarehouseError("query", backend)).toBe(backend)
		expect(normalizeWarehouseError("query", local)).toBe(local)
		expect(local.error.title).toBe("Query data could not be read")
	})

	it("wraps an unstructured failure exactly once", () => {
		const cause = new Error("transport failed")
		const normalized = normalizeWarehouseError("query", cause)
		expect(normalized).toBeInstanceOf(WarehouseQueryError)
		if (!(normalized instanceof WarehouseQueryError)) throw new Error("expected WarehouseQueryError")
		expect(normalized.message).toBe("transport failed")
		expect(normalized.cause).toBe(cause)
		expect(normalizeWarehouseError("query", normalized)).toBe(normalized)
	})
})

const transportFailure = () =>
	new HttpClientError.HttpClientError({
		reason: new HttpClientError.TransportError({
			request: HttpClientRequest.post(`${apiBaseUrl}/internal/query-engine/execute-batch`),
			cause: new TypeError("Failed to fetch"),
		}),
	})

/**
 * A dropped connection is the network, not the warehouse — but only while it is
 * still short enough to be a blip. Past the grace window the API is genuinely
 * unreachable and the failure reports exactly as it did before.
 */
describe("transport failures during a connectivity blip", () => {
	const origin = originOf(apiBaseUrl)

	beforeEach(() => {
		noteReachable(origin)
	})

	it("classifies a transport failure as unreachable while the origin is blipping", () => {
		noteUnreachable(origin, Date.now())

		const normalized = normalizeWarehouseError("query", transportFailure())

		expect(normalized).toBeInstanceOf(WarehouseUnreachableError)
		if (!(normalized instanceof WarehouseUnreachableError)) throw new Error("expected unreachable")
		// The user is told the API is unreachable and that it retries — never that
		// their query needs fixing.
		expect(normalized.error.title).toBe("Cannot reach Maple API")
		expect(normalized.error.retryable).toBe(true)
	})

	it("unwraps a transport failure nested behind another error", () => {
		noteUnreachable(origin, Date.now())
		const wrapped = new Error("Warehouse batch request failed", { cause: transportFailure() })

		expect(normalizeWarehouseError("query", wrapped)).toBeInstanceOf(WarehouseUnreachableError)
	})

	it("reports a transport failure once the outage outlasts the grace window", () => {
		noteUnreachable(origin, Date.now() - PEER_OUTAGE_GRACE_MS - 1)

		expect(normalizeWarehouseError("query", transportFailure())).toBeInstanceOf(WarehouseQueryError)
	})

	it("leaves a failure the API actually answered alone, blip or not", () => {
		noteUnreachable(origin, Date.now())

		expect(normalizeWarehouseError("query", new Error("decode failed"))).toBeInstanceOf(
			WarehouseQueryError,
		)
	})
})
