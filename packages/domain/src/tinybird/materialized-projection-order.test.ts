import { describe, expect, it } from "vitest"
import { datasources, pipes } from "../generated/tinybird-project-manifest"

interface Resource {
	readonly name: string
	readonly content: string
}

const blockBody = (resource: Resource, section: string): string => {
	const match = new RegExp(`${section} >\\n([\\s\\S]*?)(?:\\n\\n[A-Z_]+(?: |\\n|")|$)`).exec(
		resource.content,
	)
	expect(match, `${resource.name} should include ${section} block`).not.toBeNull()
	return match![1]!.replace(/^    /gm, "").trim()
}

const splitTopLevelCommas = (input: string): string[] => {
	const parts: string[] = []
	let start = 0
	let depth = 0
	let inString = false

	for (let index = 0; index < input.length; index++) {
		const char = input[index]
		const previous = input[index - 1]

		if (char === "'" && previous !== "\\") {
			inString = !inString
			continue
		}

		if (inString) continue
		if (char === "(") depth++
		if (char === ")") depth--

		if (char === "," && depth === 0) {
			parts.push(input.slice(start, index).trim())
			start = index + 1
		}
	}

	parts.push(input.slice(start).trim())
	return parts.filter((part) => part.length > 0)
}

const datasourceColumns = (resource: Resource): string[] =>
	splitTopLevelCommas(blockBody(resource, "SCHEMA")).map((column) => {
		const match = /^([A-Za-z_][A-Za-z0-9_]*)\s+/.exec(column)
		expect(match, `could not parse datasource column from ${column}`).not.toBeNull()
		return match![1]!
	})

const findTopLevelFrom = (sql: string): number => {
	let depth = 0
	let inString = false

	for (let index = 0; index < sql.length; index++) {
		const char = sql[index]
		const previous = sql[index - 1]

		if (char === "'" && previous !== "\\") {
			inString = !inString
			continue
		}

		if (inString) continue
		if (char === "(") depth++
		if (char === ")") depth--

		if (depth === 0 && /^FROM\b/i.test(sql.slice(index)) && (index === 0 || /\s/.test(sql[index - 1]!))) {
			return index
		}
	}

	throw new Error(`could not find top-level FROM in SQL:\n${sql}`)
}

const pipeSelectColumns = (resource: Resource): string[] => {
	const sql = blockBody(resource, "SQL")
	const selectMatch = /\bSELECT\b/i.exec(sql)
	expect(selectMatch, `${resource.name} should include SELECT`).not.toBeNull()

	const selectStart = selectMatch!.index + selectMatch![0]!.length
	const selectList = sql.slice(selectStart, findTopLevelFrom(sql))

	return splitTopLevelCommas(selectList).map((expression) => {
		const normalized = expression.replace(/\s+/g, " ").trim()
		const alias = /\s+AS\s+([A-Za-z_][A-Za-z0-9_]*)$/i.exec(normalized)
		if (alias) return alias[1]!

		const bareColumn = /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(normalized)
		expect(bareColumn, `SELECT expression needs an explicit alias: ${normalized}`).not.toBeNull()
		return bareColumn![1]!
	})
}

describe("materialized projection order", () => {
	it("keeps materialized projections aligned with target datasource column order", () => {
		const targets = [
			["service_map_edges_hourly", "service_map_edges_hourly_ingest_mv"],
			["service_overview_spans", "service_overview_spans_mv"],
			["service_overview_hourly", "service_overview_hourly_mv"],
			["service_operations_hourly", "service_operations_hourly_mv"],
			["trace_list_mv", "trace_list_mv_mv"],
			["logs_aggregates_hourly", "logs_aggregates_hourly_mv"],
			["error_events_by_time", "error_events_by_time_mv"],
			["error_fingerprints_minutely", "error_fingerprints_minutely_mv"],
		] as const

		for (const [datasourceName, pipeName] of targets) {
			const datasource = datasources.find((resource) => resource.name === datasourceName)
			const pipe = pipes.find((resource) => resource.name === pipeName)
			expect(datasource, `${datasourceName} datasource should exist`).toBeDefined()
			expect(pipe, `${pipeName} pipe should exist`).toBeDefined()

			expect(pipeSelectColumns(pipe!)).toEqual(datasourceColumns(datasource!))
		}
	})
})
