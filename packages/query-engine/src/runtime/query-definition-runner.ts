import type { CompiledQuery, QueryBuilderError } from "@maple-dev/clickhouse-builder"
import { Effect, type Option } from "effect"
import { baselineWarehouseCapabilities, type WarehouseCapabilities } from "../capabilities"
import type { SqlQueryOptions } from "../profiles"
import type { QueryDefinition } from "../registry/query-definition"

export interface QueryDefinitionTenant {
	readonly orgId: string
}

export interface QueryDefinitionWarehouse<Tenant extends QueryDefinitionTenant, Error> {
	readonly compiledQuery: <Row>(
		tenant: Tenant,
		compiled: CompiledQuery<Row>,
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
			| CompiledQuery<Row>
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

	// The capability-aware branch hands the compile to the warehouse, which
	// resolves capabilities first; the plain branch compiles here. Both treat a
	// compile failure as a defect — a definition that cannot compile its own
	// payload is a bug in the definition, not a condition a route reports.
	return definition.capabilityAware
		? warehouse.compiledQueryWithCapabilities(
				tenant,
				(capabilities) => definition.compile(payload, tenant.orgId, capabilities),
				options,
			)
		: definition.compile(payload, tenant.orgId, baselineWarehouseCapabilities()).pipe(
				Effect.orDie,
				Effect.flatMap((compiled) => warehouse.compiledQuery(tenant, compiled, options)),
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
		: definition.compile(payload, tenant.orgId, baselineWarehouseCapabilities()).pipe(
				Effect.orDie,
				Effect.flatMap((compiled) =>
					warehouse.compiledQueryFirst(
						tenant,
						compiled,
						queryDefinitionOptions(definition, payload),
					),
				),
			)
