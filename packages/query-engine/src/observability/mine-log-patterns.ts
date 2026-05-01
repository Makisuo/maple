import { Effect } from "effect"
import type { ListLogsOutput } from "@maple/domain/tinybird"
import { TinybirdExecutor } from "./TinybirdExecutor"
import type { MineLogPatternsInput, LogPattern } from "./types"
import { TemplateMiner, TemplateMinerConfig } from "../drain"

const DEFAULT_SAMPLE_SIZE = 10_000
const DEFAULT_LIMIT = 50

/**
 * Cluster log messages into Drain templates and return a ranked summary.
 *
 * Performance note: this samples up to `sampleSize` recent logs from the
 * configured time range / filters and feeds each body through the Drain
 * algorithm in-process. Memory is O(sample), not O(matched). Pair with a
 * narrow time range and selective filters for large data sets.
 */
export const mineLogPatterns = Effect.fn("Observability.mineLogPatterns")(function* (
	input: MineLogPatternsInput,
) {
	const executor = yield* TinybirdExecutor
	const sampleSize = input.sampleSize ?? DEFAULT_SAMPLE_SIZE
	const limit = input.limit ?? DEFAULT_LIMIT

	const optionalParams: Record<string, unknown> = {
		...(input.service && { service: input.service }),
		...(input.severity && { severity: input.severity }),
		...(input.search && { body_search: input.search }),
		...(input.traceId && { trace_id: input.traceId }),
	}

	const result = yield* executor.query<ListLogsOutput>(
		"list_logs",
		{
			start_time: input.timeRange.startTime,
			end_time: input.timeRange.endTime,
			limit: sampleSize,
			...optionalParams,
		},
		{ profile: "list" },
	)

	const config = new TemplateMinerConfig()
	// Common variable patterns. Order matters — IPs and UUIDs first, then
	// generic numbers, so a UUID isn't masked by the numeric token.
	config.maskingInstructions = [
		{ pattern: "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", maskWith: "uuid" },
		{ pattern: "\\d+\\.\\d+\\.\\d+\\.\\d+", maskWith: "ip" },
		{ pattern: "0x[0-9a-fA-F]+", maskWith: "hex" },
		{ pattern: "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}", maskWith: "email" },
	]

	const miner = new TemplateMiner(config)
	const clusters = new Map<
		number,
		{
			template: string
			count: number
			sample: string
			severityCounts: Map<string, number>
			serviceCounts: Map<string, number>
		}
	>()

	for (const row of result.data) {
		const body = String(row.body ?? "")
		if (body.length === 0) continue

		const mined = miner.addLogMessage(body)
		const existing = clusters.get(mined.clusterId)
		if (existing) {
			existing.count += 1
			existing.template = mined.templateMined
			incrementCount(existing.severityCounts, String(row.severityText ?? "UNKNOWN"))
			incrementCount(existing.serviceCounts, String(row.serviceName ?? "unknown"))
		} else {
			const severityCounts = new Map<string, number>()
			incrementCount(severityCounts, String(row.severityText ?? "UNKNOWN"))
			const serviceCounts = new Map<string, number>()
			incrementCount(serviceCounts, String(row.serviceName ?? "unknown"))
			clusters.set(mined.clusterId, {
				template: mined.templateMined,
				count: 1,
				sample: body,
				severityCounts,
				serviceCounts,
			})
		}
	}

	const patterns: LogPattern[] = Array.from(clusters.values())
		.map((c) => ({
			template: c.template,
			count: c.count,
			sample: c.sample,
			severityCounts: mapToObject(c.severityCounts),
			serviceCounts: mapToObject(c.serviceCounts),
		}))
		.sort((a, b) => b.count - a.count)
		.slice(0, limit)

	yield* Effect.annotateCurrentSpan("totalSampled", result.data.length)
	yield* Effect.annotateCurrentSpan("clusterCount", clusters.size)

	return {
		timeRange: input.timeRange,
		sampleSize,
		totalSampled: result.data.length,
		patterns,
	}
})

const incrementCount = (m: Map<string, number>, key: string): void => {
	m.set(key, (m.get(key) ?? 0) + 1)
}

const mapToObject = (m: Map<string, number>): Record<string, number> => {
	const obj: Record<string, number> = {}
	for (const [k, v] of m) obj[k] = v
	return obj
}
