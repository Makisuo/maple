import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { WarehouseQuotaExceededError, WarehouseUpstreamError } from "@maple/domain/http"
import { V2RateLimitError, V2ServiceUnavailableError } from "@maple/domain/http/v2"
import { mapAlertError } from "./alerts-error-map"

describe("mapAlertError", () => {
	it.effect("preserves transient warehouse failures as HTTP 503", () =>
		Effect.gen(function* () {
			const error = yield* Effect.fail(
				new WarehouseUpstreamError({
					message: "warehouse temporarily unavailable",
					pipeName: "listRuleChecks",
					upstreamStatus: 503,
				}),
			).pipe(mapAlertError("rule_checks_list"), Effect.flip)

			assert.instanceOf(error, V2ServiceUnavailableError)
			assert.strictEqual(error.error.code, "alert_rule_checks_list_unavailable")
		}),
	)

	it.effect("keeps warehouse quota failures as HTTP 429", () =>
		Effect.gen(function* () {
			const error = yield* Effect.fail(
				new WarehouseQuotaExceededError({
					message: "query quota exceeded",
					pipeName: "listRuleChecks",
					setting: "max_execution_time",
				}),
			).pipe(mapAlertError("rule_checks_list"), Effect.flip)

			assert.instanceOf(error, V2RateLimitError)
		}),
	)
})
