import { canonicalJson, type RunOutput, type SampleResult } from "./model"

export type ComparisonMetric =
	| "p95WallMs"
	| "meanServerMs"
	| "meanReadRows"
	| "meanReadBytes"
	| "meanMemoryUsage"
export interface ComparisonOptions {
	readonly metric: ComparisonMetric
	readonly thresholdPercent: number
	readonly minDelta: number
}

export interface ComparisonRow {
	readonly id: string
	readonly status:
		| "ok"
		| "regression"
		| "missing"
		| "added"
		| "failed"
		| "incompatible"
		| "unavailable"
		| "result-mismatch"
	readonly baseline: number | null
	readonly candidate: number | null
	readonly delta: number | null
	readonly percent: number | null
	readonly sqlChanged: boolean
	readonly reason: string
}

export const compareRuns = (a: RunOutput, b: RunOutput, options: ComparisonOptions) => {
	const warnings: string[] = []
	const incompatible: string[] = []
	for (const key of [
		"target",
		"database",
		"serverVersion",
		"dataset",
		"runsPerQuery",
		"warmupRuns",
		"verifyResults",
		"resultOrder",
	] as const) {
		if (a[key] !== b[key]) incompatible.push(`${key} differs`)
	}
	if (canonicalJson(a.settings) !== canonicalJson(b.settings))
		incompatible.push("benchmark settings differ")
	if (a.dataset === "unspecified" || b.dataset === "unspecified")
		warnings.push("No dataset revision recorded; confirm that both runs read the same data.")
	if (a.runsPerQuery < 20 || b.runsPerQuery < 20)
		warnings.push("Fewer than 20 runs: p95/p99 are noisy; repeat before drawing latency conclusions.")
	warnings.push(...a.warnings.map((w) => `baseline: ${w}`), ...b.warnings.map((w) => `candidate: ${w}`))
	const byId = new Map(b.results.map((r) => [r.id, r]))
	const ids = new Set(a.results.map((r) => r.id))
	const hashes = (r: SampleResult) => new Set(r.runs.map((run) => run.resultHash))
	const rows: ComparisonRow[] = a.results.map((before) => {
		const after = byId.get(before.id)
		const av = before.aggregates[options.metric]
		const bv = after?.aggregates[options.metric] ?? null
		const delta = av !== null && bv !== null ? bv - av : null
		const percent = delta !== null && av !== null && av !== 0 ? (delta / av) * 100 : null
		const row = {
			id: before.id,
			baseline: av,
			candidate: bv,
			delta,
			percent,
			sqlChanged: after ? before.sql !== after.sql : false,
		}
		const finish = (status: ComparisonRow["status"], reason: string): ComparisonRow => ({
			...row,
			status,
			reason,
		})
		if (!after) return finish("missing", "Case missing from candidate")
		if (
			before.error ||
			after.error ||
			before.runs.length !== a.runsPerQuery ||
			after.runs.length !== b.runsPerQuery
		)
			return finish("failed", before.error ?? after.error ?? "Incomplete measurements")
		if (incompatible.length || before.inputs !== after.inputs || before.profile !== after.profile)
			return finish(
				"incompatible",
				[
					...incompatible,
					...(before.inputs !== after.inputs ? ["case inputs differ"] : []),
					...(before.profile !== after.profile ? ["profile differs"] : []),
				].join("; "),
			)
		if (a.verifyResults) {
			const ah = hashes(before)
			const bh = hashes(after)
			if (
				ah.has(undefined) ||
				bh.has(undefined) ||
				ah.size !== 1 ||
				bh.size !== 1 ||
				[...ah][0] !== [...bh][0]
			)
				return finish("result-mismatch", "Results differ or are unstable across iterations")
		}
		if (av === null || bv === null) return finish("unavailable", `Missing ${options.metric} measurements`)
		const runMetric = {
			p95WallMs: "wallMs",
			meanServerMs: "serverElapsedMs",
			meanReadRows: "readRows",
			meanReadBytes: "readBytes",
			meanMemoryUsage: "memoryUsage",
		} as const
		if ([...before.runs, ...after.runs].some((run) => run[runMetric[options.metric]] === null)) {
			return finish("unavailable", `Incomplete ${options.metric} measurements`)
		}
		if (
			delta !== null &&
			delta > options.minDelta &&
			(av === 0 ? bv > 0 : (percent ?? 0) > options.thresholdPercent)
		)
			return finish("regression", `${options.metric} exceeded both thresholds`)
		return finish("ok", "")
	})
	for (const result of b.results) {
		if (!ids.has(result.id))
			rows.push({
				id: result.id,
				status: "added",
				baseline: null,
				candidate: result.aggregates[options.metric],
				delta: null,
				percent: null,
				sqlChanged: false,
				reason: "No baseline",
			})
	}
	return {
		metric: options.metric,
		thresholdPercent: options.thresholdPercent,
		minDelta: options.minDelta,
		warnings,
		rows,
		failed: rows.length === 0 || rows.some((r) => r.status !== "ok"),
	}
}
