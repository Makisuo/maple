import { describe, expect, it } from "vitest"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { compile } from "@maple-dev/clickhouse-builder/sql"
import { DEPLOYMENT_ENV_SQL, deploymentEnvExpr } from "./deployment-env-sql"
import { latestSnapshotStatements } from "../generated/clickhouse-schema"

describe("deployment environment SQL", () => {
	it("prefers the stable key and falls back to the deprecated one", () => {
		expect(DEPLOYMENT_ENV_SQL).toBe(
			"coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment'])",
		)
	})

	it("compiles byte-identically from the DSL expression the read side uses", () => {
		const attrs = CH.dynamicColumn<Record<string, string>>("ResourceAttributes")
		const readSide = deploymentEnvExpr({ get: (key: string) => CH.mapGet(attrs, key) })
		expect(compile(readSide.toFragment())).toBe(DEPLOYMENT_ENV_SQL)
	})

	// The regression this guards: an MV that reads only the deprecated key
	// materializes an EMPTY environment for any service instrumented with an OTel
	// SDK new enough to have adopted the rename — and the rollups are what the
	// dashboards read. See ClickHouse migration 0020.
	it("is the only way a materialized view extracts DeploymentEnv", () => {
		const offenders = latestSnapshotStatements
			.filter((statement) => statement.includes("CREATE MATERIALIZED VIEW"))
			.filter((statement) => statement.includes("AS DeploymentEnv"))
			.filter((statement) => !statement.includes(`${DEPLOYMENT_ENV_SQL} AS DeploymentEnv`))
			.map((statement) => statement.match(/VIEW IF NOT EXISTS (\w+)/)?.[1])
		expect(offenders).toEqual([])
	})
})
