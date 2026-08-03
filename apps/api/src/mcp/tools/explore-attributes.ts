import { optionalNumberParam, optionalStringParam, type McpToolRegistrar } from "./types"
import { toMcpQueryError } from "@/mcp/lib/map-warehouse-error"
import { resolveTenant } from "@/mcp/lib/query-warehouse"
import { queryWarehouse } from "@/mcp/lib/query-warehouse"
import { resolveTimeRange, rangeExceededResult, MCP_DISCOVERY_MAX_HOURS } from "@/mcp/lib/time"
import { clampLimit } from "@/mcp/lib/limits"
import { formatNumber, formatTable } from "@/mcp/lib/format"
import { Array as Arr, Effect, Schema } from "effect"
import { createDualContent } from "@/mcp/lib/structured-output"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import { exploreAttributeKeys, exploreAttributeValues } from "@maple/query-engine/observability"
import { makeWarehouseExecutorFromTenant } from "@/lib/WarehouseQueryService"

export function registerExploreAttributesTool(server: McpToolRegistrar) {
	server.tool(
		"explore_attributes",
		"Discover available attribute keys and their values. Call this before query_data or search_traces when you need to filter by custom attributes. " +
			"Use source=services to discover available environments and commit SHAs for comparison.",
		Schema.Struct({
			source: Schema.Literals(["traces", "metrics", "services"]).annotate({
				description:
					"Data source. Use 'traces' to discover span/resource attribute keys (e.g. http.method, user.id). " +
					"Use 'metrics' to discover metric attribute keys. " +
					"Use 'services' to discover available environments and commit SHAs.",
			}),
			scope: optionalStringParam(
				"Attribute scope for traces: 'span' (default) or 'resource'. Ignored for metrics/services.",
			),
			key: optionalStringParam(
				"When provided, returns values for this key instead of listing all keys",
			),
			service_name: optionalStringParam("Filter by service name"),
			start_time: optionalStringParam("Start time (YYYY-MM-DD HH:mm:ss)"),
			end_time: optionalStringParam("End time (YYYY-MM-DD HH:mm:ss)"),
			limit: optionalNumberParam("Max results (default 50)"),
		}),
		Effect.fn("McpTool.exploreAttributes")(function* (params) {
			const range = resolveTimeRange(params.start_time, params.end_time, {
				maxHours: MCP_DISCOVERY_MAX_HOURS,
			})
			const { st, et } = range
			if (range.exceeded) return rangeExceededResult(range, "explore_attributes")
			const lim = clampLimit(params.limit, { defaultValue: 50, max: 500 })
			const scope = (params.scope ?? "span") as "span" | "resource"
			const tenant = yield* resolveTenant
			const executorLayer = makeWarehouseExecutorFromTenant(tenant)
			const mapError = toMcpQueryError("explore_attributes")

			const baseInput = {
				source: params.source as "traces" | "metrics" | "services",
				scope,
				service: params.service_name ?? undefined,
				timeRange: { startTime: st, endTime: et },
				limit: lim,
			}

			if (params.key) {
				// Return values for a specific key
				const values = yield* exploreAttributeValues({ ...baseInput, key: params.key }).pipe(
					Effect.provide(executorLayer),
					Effect.mapError(mapError),
				)

				// Metric labels are their own scope; span/resource scoping only applies to traces.
				const sourceLabel = params.source === "metrics" ? "metrics" : `${params.source} (${scope})`
				const lines: string[] = [
					`## Attribute Values: ${params.key}`,
					`Source: ${sourceLabel}`,
					`Time range: ${st} — ${et}`,
					``,
				]

				if (values.length === 0) {
					lines.push("No values found for this key.")
				} else {
					lines.push(
						formatTable(
							["Value", "Count"],
							Arr.map(values, (v) => [v.value, formatNumber(v.count)]),
						),
					)
				}

				lines.push(
					formatNextSteps(
						params.source === "metrics"
							? [
									`\`query_data source="metrics" kind="breakdown" group_by="attribute" attribute_key="${params.key}"\` — break a metric down by this label`,
								]
							: [
									`\`query_data source="traces" kind="timeseries" attribute_key="${params.key}" attribute_value="<value>"\` — chart traces filtered by this attribute`,
								],
					),
				)

				return {
					content: createDualContent(lines.join("\n"), {
						tool: "explore_attributes",
						data: {
							source: params.source,
							scope,
							key: params.key,
							timeRange: { start: st, end: et },
							values: [...values],
						},
					}),
				}
			}

			// Services source uses different pipe - delegate to queryWarehouse directly
			if (params.source === "services") {
				const result = yield* queryWarehouse<{
					facetType: string
					name: string
					count?: number
				}>("services_facets", { start_time: st, end_time: et })

				const environments = Arr.filter(result.data, (r) => r.facetType === "environment")
				const commitShas = Arr.filter(result.data, (r) => r.facetType === "commit_sha")

				const lines: string[] = [
					`## Available Environments & Deployments`,
					`Time range: ${st} — ${et}`,
					``,
				]

				if (environments.length > 0) {
					lines.push(`### Environments`)
					lines.push(
						formatTable(
							["Environment", "Span Count"],
							Arr.map(environments, (r) => [String(r.name), formatNumber(r.count ?? 0)]),
						),
					)
				}
				if (commitShas.length > 0) {
					lines.push(``, `### Commit SHAs`)
					lines.push(
						formatTable(
							["Commit SHA", "Span Count"],
							Arr.map(commitShas, (r) => [String(r.name), formatNumber(r.count ?? 0)]),
						),
					)
				}

				const nextSteps: string[] = []
				if (environments.length > 0)
					nextSteps.push(
						`\`list_services environment="${String(environments[0].name)}"\` — see services in this environment`,
					)
				if (commitShas.length > 1)
					nextSteps.push("`compare_periods` — compare performance between deploys")
				lines.push(formatNextSteps(nextSteps))

				return {
					content: createDualContent(lines.join("\n"), {
						tool: "explore_attributes",
						data: {
							source: "services",
							timeRange: { start: st, end: et },
							keys: [
								...Arr.map(environments, (r) => ({
									key: `environment:${String(r.name)}`,
									count: Number(r.count ?? 0),
								})),
								...Arr.map(commitShas, (r) => ({
									key: `commit_sha:${String(r.name)}`,
									count: Number(r.count ?? 0),
								})),
							],
						},
					}),
				}
			}

			// List keys for traces or metrics
			const keys = yield* exploreAttributeKeys(baseInput).pipe(
				Effect.provide(executorLayer),
				Effect.mapError(mapError),
			)

			const lines: string[] = [
				`## Attribute Keys`,
				`Source: ${params.source} (${scope})`,
				`Time range: ${st} — ${et}`,
				``,
			]

			if (keys.length === 0) {
				lines.push("No attribute keys found.")
			} else {
				lines.push(
					formatTable(
						["Key", "Count"],
						Arr.map(keys, (k) => [k.key, formatNumber(k.count)]),
					),
				)
			}

			const nextSteps = Arr.map(
				Arr.take(keys, 3),
				(k) =>
					`\`explore_attributes source="${params.source}" key="${k.key}"\` — see values for this key`,
			)
			lines.push(formatNextSteps(nextSteps))

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "explore_attributes",
					data: {
						source: params.source,
						scope,
						timeRange: { start: st, end: et },
						keys: [...keys],
					},
				}),
			}
		}),
	)
}
