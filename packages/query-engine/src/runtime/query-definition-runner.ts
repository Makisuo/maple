import type { CompiledQuery, CompiledQueryInput, QueryBuilderError } from "@maple-dev/clickhouse-builder"
import type { Effect, Option } from "effect"
import { baselineWarehouseCapabilities, type WarehouseCapabilities } from "../capabilities"
import type { SqlQueryOptions } from "../profiles"
import type { QueryDefinition } from "../registry/query-definition"

export interface QueryDefinitionTenant {
	readonly orgId: string
}

export interface QueryDefinitionWarehouse<Tenant extends QueryDefinitionTenant, Error> {
	readonly compiledQuery: <Row>(
		tenant: Tenant,
		compiled: CompiledQueryInput<Row>,
		options: SqlQueryOptions,
	) => Effect.Effect<ReadonlyArray<Row>, Error>
	readonly compiledQueryWithCapabilities: <Row>(
		tenant: Tenant,
		compile: (
			capabilities: WarehouseCapabilities,
		) => Effect.Effect<CompiledQuery<Row>, QueryBuilderError>,
		options: SqlQueryOptions,
	) => Effect.Effect<ReadonlyArray<Row>, Error>
}

export interface QueryDefinitionFirstWarehouse<Tenant extends QueryDefinitionTenant, Error> {
	readonly compiledQueryFirst: <Row>(
		tenant: Tenant,
		compiled:
			| CompiledQueryInput<Row>
			| ((capabilities: WarehouseCapabilities) => Effect.Effect<CompiledQuery<Row>, QueryBuilderError>),
		options: SqlQueryOptions,
	) => Effect.Effect<Option.Option<Row>, Error>
}

const queryDefinitionOptions = <Payload, Row>(
	definition: QueryDefinition<Payload, Row>,
	payload: Payload,
): SqlQueryOptions => {
	const settings =
		typeof definition.settings === "function" ? definition.settings(payload) : definition.settings
	return {
		profile: definition.profile,
		context: definition.id,
		...(!(settings === undefined) ? { settings } : undefined),
	}
}

/** Executes a definition without caching; cache orchestration is caller-owned. */
export const runQueryDefinition = <Payload, Row, Tenant extends QueryDefinitionTenant, Error>(
	warehouse: QueryDefinitionWarehouse<Tenant, Error>,
	definition: QueryDefinition<Payload, Row>,
	tenant: Tenant,
	payload: Payload,
): Effect.Effect<ReadonlyArray<Row>, Error> => {
	const options = queryDefinitionOptions(definition, payload)

	// Both branches hand the warehouse an unrun compile: the capability-aware one
	// so capabilities resolve first, the plain one against the baseline. Neither
	// judges the failure here — a definition that cannot compile its own payload
	// is a bug, which is exactly what the warehouse does with it.
	return definition.capabilityAware
		? warehouse.compiledQueryWithCapabilities(
				tenant,
				(capabilities) => definition.compile(payload, tenant.orgId, capabilities),
				options,
			)
		: warehouse.compiledQuery(
				tenant,
				definition.compile(payload, tenant.orgId, baselineWarehouseCapabilities()),
				options,
			)
}

export const runQueryDefinitionFirst = <Payload, Row, Tenant extends QueryDefinitionTenant, Error>(
	warehouse: QueryDefinitionFirstWarehouse<Tenant, Error>,
	definition: QueryDefinition<Payload, Row>,
	tenant: Tenant,
	payload: Payload,
): Effect.Effect<Option.Option<Row>, Error> =>
	definition.capabilityAware
		? warehouse.compiledQueryFirst(
				tenant,
				(capabilities) => definition.compile(payload, tenant.orgId, capabilities),
				queryDefinitionOptions(definition, payload),
			)
		: warehouse.compiledQueryFirst(
				tenant,
				definition.compile(payload, tenant.orgId, baselineWarehouseCapabilities()),
				queryDefinitionOptions(definition, payload),
			)
