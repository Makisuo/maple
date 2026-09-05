import { Effect, Schema } from "effect"
import type { CompiledQuery } from "@maple-dev/clickhouse-builder"
import { fingerprintSql } from "../execution/fingerprint"

const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const Metric = Schema.NullOr(NonNegative)
const Text = Schema.String.check(Schema.isMinLength(1))

export class BenchmarkError extends Schema.TaggedError<BenchmarkError>()(
	"@maple/query-engine/BenchmarkError",
	{ message: Schema.String },
) {}

/** `id` identifies the experiment, independently of its SQL implementation.
 * `inputs` records the fixed tenant/window/filters used by a custom suite. */
export const Sample = Schema.Struct({
	id: Schema.optionalKey(Text),
	inputs: Schema.optionalKey(Schema.String),
	fingerprint: Text,
	context: Schema.String,
	profile: Schema.String,
	sampleSql: Text,
})
export type Sample = typeof Sample.Type

/** Also accepts files produced by the production trace miner. */
export const Suite = Schema.Struct({ source: Text, samples: Schema.Array(Sample) })
export type Suite = typeof Suite.Type

export const RunMetrics = Schema.Struct({
	queryId: Text,
	wallMs: NonNegative,
	serverElapsedMs: Metric,
	readRows: Metric,
	readBytes: Metric,
	memoryUsage: Metric,
	resultRows: Metric,
	metricSource: Schema.Literals(["summary", "query_log"]),
	profileEvents: Schema.Record(Schema.String, NonNegative),
	resultHash: Schema.optionalKey(Text),
})
export type RunMetrics = typeof RunMetrics.Type

export const Aggregates = Schema.Struct({
	p50WallMs: Metric,
	p95WallMs: Metric,
	p99WallMs: Metric,
	meanServerMs: Metric,
	meanReadRows: Metric,
	meanReadBytes: Metric,
	meanMemoryUsage: Metric,
	stddevWallMs: Metric,
})

export const SampleResult = Schema.Struct({
	id: Text,
	inputs: Schema.optionalKey(Schema.String),
	fingerprint: Text,
	context: Schema.String,
	profile: Schema.String,
	sql: Text,
	runs: Schema.Array(RunMetrics),
	aggregates: Aggregates,
	error: Schema.optionalKey(Schema.String),
})
export type SampleResult = typeof SampleResult.Type

export const RunOutput = Schema.Struct({
	version: Schema.Literal(1),
	ranAt: Text,
	target: Text,
	database: Text,
	serverVersion: Text,
	dataset: Text,
	sourceFile: Text,
	source: Text,
	runsPerQuery: NonNegative.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
	warmupRuns: NonNegative.check(Schema.isInt()),
	settings: Schema.Record(Schema.String, Schema.String),
	verifyResults: Schema.Boolean,
	resultOrder: Schema.Literals(["ordered", "unordered"]),
	warnings: Schema.Array(Schema.String),
	results: Schema.Array(SampleResult),
})
export type RunOutput = typeof RunOutput.Type

/** Stable serialization for scenario inputs; object key ordering is irrelevant. */
export const canonicalJson = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
	if (typeof value === "object" && value !== null) {
		return `{${Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
			.join(",")}}`
	}
	return JSON.stringify(value) ?? "null"
}

/** JSON-compatible scenario inputs; convert Sets/Maps/Dates explicitly. */
export type BenchmarkInput =
	| null
	| string
	| number
	| boolean
	| ReadonlyArray<BenchmarkInput>
	| { readonly [key: string]: BenchmarkInput | undefined }

/** Build a case from the actual DSL output, without copying generated SQL. */
export const caseFromCompiled = (
	id: string,
	compiled: CompiledQuery<unknown>,
	inputs: Readonly<Record<string, BenchmarkInput | undefined>>,
): Sample => ({
	id,
	inputs: canonicalJson(inputs),
	context: id,
	profile: "",
	fingerprint: fingerprintSql(compiled.sql),
	sampleSql: compiled.sql,
})

export const sampleId = (sample: Sample): string =>
	sample.id ?? `${sample.context}:${sample.profile}:${sample.fingerprint}`

export const validateSuite = (suite: Suite) => {
	const ids = suite.samples.map(sampleId)
	return suite.samples.length === 0 || new Set(ids).size !== ids.length
		? Effect.fail(new BenchmarkError({ message: "A suite needs at least one case and unique case IDs." }))
		: Effect.succeed(suite)
}

/** Nearest-rank percentile: p50 of five observations is the third, p95 the fifth. */
export const percentile = (values: ReadonlyArray<number>, p: number): number | null => {
	const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
	return sorted.length === 0
		? null
		: (sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? null)
}

export const mean = (values: ReadonlyArray<number | null>): number | null => {
	const finite = values.filter((v): v is number => v !== null && Number.isFinite(v))
	return finite.length === 0 ? null : finite.reduce((a, b) => a + b, 0) / finite.length
}

export const aggregate = (runs: ReadonlyArray<RunMetrics>): typeof Aggregates.Type => {
	const wall = runs.map((r) => r.wallMs)
	const average = mean(wall)
	return {
		p50WallMs: percentile(wall, 50),
		p95WallMs: percentile(wall, 95),
		p99WallMs: percentile(wall, 99),
		meanServerMs: mean(runs.map((r) => r.serverElapsedMs)),
		meanReadRows: mean(runs.map((r) => r.readRows)),
		meanReadBytes: mean(runs.map((r) => r.readBytes)),
		meanMemoryUsage: mean(runs.map((r) => r.memoryUsage)),
		stddevWallMs:
			average === null || wall.length < 2
				? null
				: Math.sqrt(wall.reduce((sum, x) => sum + (x - average) ** 2, 0) / (wall.length - 1)),
	}
}

export const metricNumber = (value: unknown): number | null => {
	if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) return null
	const n = Number(value)
	return Number.isFinite(n) && n >= 0 ? n : null
}
