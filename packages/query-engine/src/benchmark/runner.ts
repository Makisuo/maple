import { Effect } from "effect"
import {
	aggregate,
	canonicalJson,
	BenchmarkError,
	metricNumber,
	sampleId,
	validateSuite,
	type RunMetrics,
	type SampleResult,
	type Suite,
} from "./model"
import { fingerprintSql } from "../execution/fingerprint"
import { benchmarkSql, validateReplaySql } from "./sql"

export interface BenchmarkResponse {
	readonly queryId: string
	readonly wallMs: number
	readonly summary: Readonly<Record<string, unknown>>
	readonly resultHash?: string
}

export interface LogMetrics {
	readonly queryId: string
	readonly serverElapsedMs: number | null
	readonly readRows: number | null
	readonly readBytes: number | null
	readonly memoryUsage: number | null
	readonly resultRows: number | null
	readonly profileEvents: Readonly<Record<string, number>>
}

export interface BenchmarkTransport {
	readonly execute: (sql: string) => Effect.Effect<BenchmarkResponse, BenchmarkError>
	/** Called once, after ALL measured executions, never between iterations. */
	readonly collectLogs: (queryIds: ReadonlyArray<string>) => Effect.Effect<
		{
			readonly entries: ReadonlyArray<LogMetrics>
			readonly warnings: ReadonlyArray<string>
		},
		BenchmarkError
	>
}

export interface RunOptions {
	readonly runs: number
	readonly warmup: number
	readonly settings: Readonly<Record<string, string>>
	readonly verifyResults: boolean
}

/** Serial, rotating rounds reduce order bias without adding concurrent load.
 * Query failures preserve completed measurements and fail the eventual gate. */
export const runSuite = (
	transport: BenchmarkTransport,
	suite: Suite,
	options: RunOptions,
	onProgress: (message: string) => Effect.Effect<void> = () => Effect.void,
) =>
	Effect.gen(function* () {
		yield* validateSuite(suite)
		if (
			!Number.isInteger(options.runs) ||
			options.runs < 1 ||
			options.runs > 1000 ||
			!Number.isInteger(options.warmup) ||
			options.warmup < 0 ||
			options.warmup > 100
		) {
			return yield* Effect.fail(
				new BenchmarkError({ message: "runs must be 1–1000 and warmup 0–100 (integers)." }),
			)
		}
		// Validate the entire suite before issuing any request.
		yield* Effect.forEach(suite.samples, (s) => validateReplaySql(s.sampleSql), { discard: true })
		const states = suite.samples.map((sample) => ({
			sample,
			sql: benchmarkSql(
				sample.sampleSql,
				options.settings,
				options.verifyResults ? "JSONEachRow" : undefined,
			),
			runs: [] as RunMetrics[],
			error: undefined as string | undefined,
		}))
		for (let round = 0; round < options.warmup + options.runs; round++) {
			const warm = round < options.warmup
			for (let index = 0; index < states.length; index++) {
				const state = states[(index + round) % states.length]
				if (!state || state.error) continue
				const outcome = yield* transport.execute(state.sql).pipe(Effect.result)
				if (outcome._tag === "Failure") {
					state.error = outcome.failure.message
					yield* onProgress(`${sampleId(state.sample)}: FAILED — ${state.error}`)
					continue
				}
				if (!warm) {
					const res = outcome.success
					const ns = metricNumber(res.summary.elapsed_ns)
					state.runs.push({
						queryId: res.queryId,
						wallMs: res.wallMs,
						serverElapsedMs: ns === null ? null : ns / 1e6,
						readRows: metricNumber(res.summary.read_rows),
						readBytes: metricNumber(res.summary.read_bytes),
						memoryUsage: null,
						resultRows: metricNumber(res.summary.result_rows),
						metricSource: "summary",
						profileEvents: {},
						...(res.resultHash ? { resultHash: res.resultHash } : undefined),
					})
				}
			}
			yield* onProgress(
				`${warm ? "Warmup" : "Measured"} round ${warm ? round + 1 : round - options.warmup + 1}/${warm ? options.warmup : options.runs}`,
			)
		}
		const queryIds = states.flatMap((state) => state.runs.map((run) => run.queryId))
		yield* onProgress("Collecting query logs after timing…")
		const logResult = yield* transport.collectLogs(queryIds).pipe(Effect.result)
		const warnings =
			logResult._tag === "Failure" ? [logResult.failure.message] : [...logResult.success.warnings]
		const logs = new Map(
			(logResult._tag === "Failure" ? [] : logResult.success.entries).map((entry) => [
				entry.queryId,
				entry,
			]),
		)
		const missing = queryIds.filter((id) => !logs.has(id)).length
		if (missing)
			warnings.push(
				`${missing}/${queryIds.length} query logs unavailable; summary metrics retained, memory/ProfileEvents may be absent.`,
			)
		const results: SampleResult[] = states.map((state) => {
			const runs = state.runs.map((run): RunMetrics => {
				const log = logs.get(run.queryId)
				return log
					? {
							...run,
							...log,
							serverElapsedMs: log.serverElapsedMs ?? run.serverElapsedMs,
							readRows: log.readRows ?? run.readRows,
							readBytes: log.readBytes ?? run.readBytes,
							resultRows: log.resultRows ?? run.resultRows,
							metricSource: "query_log",
						}
					: run
			})
			if (runs.some((run) => run.readRows === 0))
				warnings.push(
					`${sampleId(state.sample)} read zero rows in at least one run; verify the dataset/window before optimizing.`,
				)
			if (options.verifyResults && new Set(runs.map((run) => run.resultHash)).size > 1)
				warnings.push(`${sampleId(state.sample)} returned different results across iterations.`)
			return {
				id: sampleId(state.sample),
				fingerprint: fingerprintSql(state.sql),
				context: state.sample.context,
				profile: state.sample.profile,
				inputs: state.sample.inputs ?? canonicalJson({ sql: state.sample.sampleSql }),
				sql: state.sql,
				runs,
				aggregates: aggregate(runs),
				...(state.error ? { error: state.error } : undefined),
			}
		})
		return { results, warnings }
	})
