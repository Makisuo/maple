import { Effect, Schema } from "effect"
import { DeploymentEnvironment, EndpointStatusBreakdownRequest, ServiceName } from "@maple/domain/http"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "@/api/warehouse/effect-utils"

/** The classes the warehouse emits, in the order they should render. */
export const STATUS_CLASS_ORDER = ["2xx", "3xx", "4xx", "5xx", "1xx", "unknown"] as const

export interface EndpointStatusSlice {
	statusClass: string
	spanCount: number
	estimatedSpanCount: number
}

const GetEndpointStatusBreakdownInput = Schema.Struct({
	serviceName: ServiceName,
	/** Display span name ("GET /api/users"). */
	spanName: Schema.String,
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
	environments: Schema.optional(Schema.Array(DeploymentEnvironment)),
})

export type GetEndpointStatusBreakdownInput = (typeof GetEndpointStatusBreakdownInput)["Encoded"]

export const getEndpointStatusBreakdown = Effect.fn("QueryEngine.getEndpointStatusBreakdown")(function* ({
	data,
}: {
	data: GetEndpointStatusBreakdownInput
}) {
	const input = yield* decodeInput(GetEndpointStatusBreakdownInput, data, "getEndpointStatusBreakdown")

	const result = yield* runWarehouseQuery("endpointStatusBreakdown", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.endpointStatusBreakdown({
				payload: new EndpointStatusBreakdownRequest({
					serviceName: input.serviceName,
					spanName: input.spanName,
					startTime: input.startTime,
					endTime: input.endTime,
					environments: input.environments,
				}),
			})
		}),
	)

	// Ordered here rather than in SQL so the chart's stack order is a UI decision
	// (2xx first, degrading to 5xx) instead of a lexical accident.
	const rank = (statusClass: string) => {
		const index = STATUS_CLASS_ORDER.indexOf(statusClass as (typeof STATUS_CLASS_ORDER)[number])
		return index === -1 ? STATUS_CLASS_ORDER.length : index
	}
	const slices: EndpointStatusSlice[] = result.data
		.map((row) => ({
			statusClass: row.statusClass,
			spanCount: row.spanCount,
			estimatedSpanCount: row.estimatedSpanCount,
		}))
		.toSorted((a, b) => rank(a.statusClass) - rank(b.statusClass))

	return { slices }
})
