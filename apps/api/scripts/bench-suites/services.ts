/** Edit the inputs to a representative, fixed window in a populated snapshot.
 * Re-export on both revisions; keep case IDs and inputs stable. */
import { Effect } from "effect"
import * as CH from "@maple/query-engine/ch"
import { caseFromCompiled, type Suite } from "@maple/query-engine/benchmark"

const inputs = {
	orgId: "org_sql_catalog",
	startTime: "2026-01-01 10:30:00",
	endTime: "2026-01-03 14:15:00",
}

// A suite is an application entry point: compilation completes before the
// benchmark timer starts. Use the same builder/options as the production path.
const compiled = await Effect.runPromise(CH.compileUnion(CH.servicesFacetsQuery(), inputs))

export default {
	source: "services-workload",
	samples: [caseFromCompiled("services/facets/partial-hours", compiled, inputs)],
} satisfies Suite
