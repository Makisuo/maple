import { assert, describe, it } from "@effect/vitest"
import { WarehouseAuthError, WarehouseConfigError, WarehouseUpstreamError } from "@maple/domain/http"
import { makeEdgeCacheService, makeMemoryBackend } from "@maple/query-engine/caching"
import { Cause, Effect } from "effect"
import {
	causeHasWarehouseConfigClassError,
	isOrgWarehouseQuarantined,
	quarantineOnConfigClassCause,
	quarantineOrgWarehouse,
} from "./warehouse-org-quarantine"

const authError = new WarehouseAuthError({ message: "invalid authentication token", pipeName: "p" })

describe("causeHasWarehouseConfigClassError", () => {
	it("matches a direct auth failure", () => {
		assert.isTrue(causeHasWarehouseConfigClassError(Cause.fail(authError)))
	})

	it("matches a config failure", () => {
		assert.isTrue(
			causeHasWarehouseConfigClassError(
				Cause.fail(new WarehouseConfigError({ message: "unknown database", pipeName: "p" })),
			),
		)
	})

	it("matches an auth error wrapped as the cause of a service error", () => {
		const wrapped = { _tag: "@maple/http/errors/AnomalyPersistenceError", cause: authError }
		assert.isTrue(causeHasWarehouseConfigClassError(Cause.fail(wrapped)))
	})

	it("matches an auth error raised as a defect", () => {
		assert.isTrue(causeHasWarehouseConfigClassError(Cause.die(authError)))
	})

	it("does not match transient upstream failures", () => {
		assert.isFalse(
			causeHasWarehouseConfigClassError(
				Cause.fail(new WarehouseUpstreamError({ message: "503", pipeName: "p" })),
			),
		)
	})

	it("does not match untagged errors", () => {
		assert.isFalse(causeHasWarehouseConfigClassError(Cause.fail(new Error("boom"))))
	})
})

describe("org quarantine", () => {
	it.effect("round-trips through the edge cache", () =>
		Effect.gen(function* () {
			const edgeCache = makeEdgeCacheService(makeMemoryBackend())
			assert.isFalse(yield* isOrgWarehouseQuarantined(edgeCache, "org_a"))
			yield* quarantineOrgWarehouse(edgeCache, "org_a", 1_000)
			assert.isTrue(yield* isOrgWarehouseQuarantined(edgeCache, "org_a"))
			assert.isFalse(yield* isOrgWarehouseQuarantined(edgeCache, "org_b"))
		}),
	)

	it.effect("quarantines only on config-class causes", () =>
		Effect.gen(function* () {
			const edgeCache = makeEdgeCacheService(makeMemoryBackend())
			const transient = yield* quarantineOnConfigClassCause(
				edgeCache,
				"org_a",
				Cause.fail(new WarehouseUpstreamError({ message: "503", pipeName: "p" })),
				1_000,
			)
			assert.isFalse(transient)
			assert.isFalse(yield* isOrgWarehouseQuarantined(edgeCache, "org_a"))

			const config = yield* quarantineOnConfigClassCause(edgeCache, "org_a", Cause.fail(authError), 1_000)
			assert.isTrue(config)
			assert.isTrue(yield* isOrgWarehouseQuarantined(edgeCache, "org_a"))
		}),
	)
})
