import { describe, expect, it } from "vitest"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { compile } from "@maple-dev/clickhouse-builder/sql"
import {
	DEPLOYMENT_ENV_SQL,
	MESSAGING_DESTINATION_SQL,
	deploymentEnvExpr,
	messagingDestinationExpr,
} from "./semconv-renames"
import { latestSnapshotStatements } from "../generated/clickhouse-schema"

describe("semconv rename coalescing", () => {
	it("prefers the stable key and falls back to the deprecated one", () => {
		expect(DEPLOYMENT_ENV_SQL).toBe(
			"coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment'])",
		)
	})

	it("prefers the namespaced messaging destination over the deprecated one", () => {
		expect(MESSAGING_DESTINATION_SQL).toBe(
			"coalesce(nullIf(SpanAttributes['messaging.destination.name'], ''), SpanAttributes['messaging.destination'])",
		)
	})

	// Byte-identity is load-bearing, not cosmetic: the service-map and
	// service-overview routes union an MV branch with a raw-`traces` branch, and
	// the two only merge if both sides compute the same grouping key.
	it("compiles byte-identically from the DSL expressions the read side uses", () => {
		const mapColumn = (name: string) => {
			const column = CH.dynamicColumn<Record<string, string>>(name)
			return { get: (key: string) => CH.mapGet(column, key) }
		}
		expect(compile(deploymentEnvExpr(mapColumn("ResourceAttributes")).toFragment())).toBe(
			DEPLOYMENT_ENV_SQL,
		)
		expect(compile(messagingDestinationExpr(mapColumn("SpanAttributes")).toFragment())).toBe(
			MESSAGING_DESTINATION_SQL,
		)
	})

	// The regression this guards: an MV that reads only the deprecated key
	// materializes an EMPTY environment for any service instrumented with an OTel
	// SDK new enough to have adopted the rename — and the rollups are what the
	// dashboards read. See ClickHouse migration 0020.
	it("leaves no materialized view reading a deprecated key on its own", () => {
		const bare = latestSnapshotStatements
			.filter((statement) => statement.includes("CREATE MATERIALIZED VIEW"))
			.filter((statement) => statement.includes("SpanAttributes['messaging.destination']"))
			.filter((statement) => !statement.includes(MESSAGING_DESTINATION_SQL))
			.map((statement) => statement.match(/VIEW IF NOT EXISTS (\w+)/)?.[1])
		expect(bare).toEqual([])
	})

	it("is the only way a materialized view extracts DeploymentEnv", () => {
		const offenders = latestSnapshotStatements
			.filter((statement) => statement.includes("CREATE MATERIALIZED VIEW"))
			.filter((statement) => statement.includes("AS DeploymentEnv"))
			.filter((statement) => !statement.includes(`${DEPLOYMENT_ENV_SQL} AS DeploymentEnv`))
			.map((statement) => statement.match(/VIEW IF NOT EXISTS (\w+)/)?.[1])
		expect(offenders).toEqual([])
	})
})
