import { Effect, Schema } from "effect"
import { coerceServiceOverviewRows, windowDurationSeconds } from "@maple/query-engine"
import { ServiceName, ServiceNamespace, ServiceOverviewRequest } from "@maple/domain/http"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import { decodeInput, runWarehouseQuery } from "@/api/warehouse/effect-utils"

export interface NamespaceServiceScope {
	/** Services filter to apply, already intersected with the caller's own. */
	services: ReadonlyArray<ServiceName> | undefined
	/** No service in the namespace(s) — the caller should answer empty without querying. */
	empty: boolean
	/** Membership set for post-filtering rows/facets, or null when unscoped. */
	memberServices: ReadonlySet<string> | null
}

/**
 * Lower a `namespaces` filter onto tables that carry no `ServiceNamespace`
 * column (error_events, traces_aggregates_hourly): resolve which services
 * emitted under those namespaces in the window (service_overview rollup,
 * server-cached) and scope by service membership instead. Approximate on
 * purpose — a service emitting under several namespaces stays visible.
 */
export const scopeServicesToNamespaces = Effect.fn("QueryEngine.scopeServicesToNamespaces")(function* (opts: {
	namespaces: ReadonlyArray<ServiceNamespace> | undefined
	services: ReadonlyArray<ServiceName> | undefined
	startTime: string
	endTime: string
}) {
	if (!opts.namespaces?.length) {
		return { services: opts.services, empty: false, memberServices: null } satisfies NamespaceServiceScope
	}

	const result = yield* runWarehouseQuery("namespaceServices", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.serviceOverview({
				payload: new ServiceOverviewRequest({
					startTime: opts.startTime,
					endTime: opts.endTime,
					namespaces: opts.namespaces,
				}),
			})
		}),
	)

	const rows = coerceServiceOverviewRows(result.data, windowDurationSeconds(opts.startTime, opts.endTime))
	const names = new Set(rows.map((row) => row.serviceName))

	if (opts.services?.length) {
		const services = opts.services.filter((service) => names.has(service))
		return { services, empty: services.length === 0, memberServices: names } satisfies NamespaceServiceScope
	}

	const services = yield* decodeInput(Schema.Array(ServiceName), [...names], "scopeServicesToNamespaces")
	return { services, empty: services.length === 0, memberServices: names } satisfies NamespaceServiceScope
})
