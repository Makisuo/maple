import { Effect } from "effect"
import { collectQueryCatalog, mergeQueryCatalogs } from "@maple/query-engine/benchmark"
import { collectIntegrationQueryCatalog } from "@maple/query-engine-integrations/benchmark"

/** One composition root for the CLI, analyzer sweep, and benchmark smoke tests. */
export const collectWarehouseQueryCatalog = () =>
	Effect.gen(function* () {
		const core = yield* collectQueryCatalog()
		const integrations = yield* collectIntegrationQueryCatalog()
		return yield* mergeQueryCatalogs(core, integrations)
	})
