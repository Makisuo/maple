// Calibration validation comparison helper for the native acceptance probe.
//
// Reads a config document and an observed-metrics JSON (produced by a REAL
// calibrate-run trial on held-out data, measured under /usr/bin/time), builds
// the typed six-metric predicted-vs-observed comparison via the PRODUCTION
// comparePredictedObserved function, and emits a CalibrationValidationReport.
//
// The trial is LIKE-FOR-LIKE with the calibration: both run an export sample
// through the same shared writer, so RSS, wall time, throughput, compression,
// physical bytes, and temp disk are directly comparable. The tolerances are
// therefore meaningful acceptance bands, not vacuous.
//
// Usage: bun calibration-validation-compare.ts <config.json> <observed.json> <genId> <signal> <rows> <shards> > report.json

import { readFileSync } from "node:fs"
import {
	comparePredictedObserved,
	HELD_OUT_TOLERANCES,
	type CandidateMetrics,
	type CalibrationValidationReport,
} from "../../src/server/archives/calibrate"

const configPath = process.argv[2]
const observedPath = process.argv[3]
const genId = process.argv[4]
const signal = process.argv[5]
const rows = Number(process.argv[6])
const shards = Number(process.argv[7])

if (!configPath || !observedPath) {
	console.error(
		"usage: calibration-validation-compare.ts <config.json> <observed.json> <genId> <signal> <rows> <shards>",
	)
	process.exit(2)
}

const config = JSON.parse(readFileSync(configPath, "utf8")) as {
	selected: {
		candidate: {
			writerThreads: number
			rowGroupRows: number
			maxShardRows: number
			maxShardBytes: number
		}
		worstCase: CandidateMetrics
	} | null
	results: Array<{
		candidate: {
			writerThreads: number
			rowGroupRows: number
			maxShardRows: number
			maxShardBytes: number
		}
		signal: string
		metrics: CandidateMetrics | null
		ok: boolean
	}>
}
const observed = JSON.parse(readFileSync(observedPath, "utf8")) as CandidateMetrics

if (!config.selected) {
	console.error("config has no selected candidate; cannot compare")
	process.exit(2)
}

const sameCandidate = (
	left: (typeof config.results)[number]["candidate"],
	right: NonNullable<typeof config.selected>["candidate"],
): boolean =>
	left.writerThreads === right.writerThreads &&
	left.rowGroupRows === right.rowGroupRows &&
	left.maxShardRows === right.maxShardRows &&
	left.maxShardBytes === right.maxShardBytes

// Compare the held-out logs trial with the selected candidate's TRAINING logs
// result. Using selected.worstCase here would compare one signal with a
// synthetic aggregate whose individual maxima/minimum may come from six
// different signals, which is not like-for-like.
const predictedResult = config.results.find(
	(result) =>
		result.signal === signal &&
		result.ok &&
		result.metrics !== null &&
		sameCandidate(result.candidate, config.selected!.candidate),
)
if (!predictedResult?.metrics) {
	console.error(`config has no successful ${signal} training result for the selected candidate`)
	process.exit(2)
}
const predicted = predictedResult.metrics
// Canonical held-out policy (the same constant the calibrator and loader use),
// with hybrid size-scaling. This independent trial is disjoint from training
// but the same size; its measured logical-byte ratio still accounts for row
// shape differences. Throughput/compression are compared directly; RSS/temp-
// disk are absolute peaks. Every tolerance is a relative delta below 1.0;
// throughput's comparator uses
// `observed >= predicted * (1-t)`, so a tolerance >= 1 would be vacuous.
if (
	!Number.isFinite(predicted.logicalBytes) ||
	predicted.logicalBytes <= 0 ||
	!Number.isFinite(observed.logicalBytes) ||
	observed.logicalBytes <= 0
) {
	console.error("training and observed logicalBytes must both be finite and positive")
	process.exit(2)
}
const scaleRatio = observed.logicalBytes / predicted.logicalBytes
const comparison = comparePredictedObserved(predicted, observed, HELD_OUT_TOLERANCES, {
	ratio: scaleRatio,
	metrics: new Set(["wallMs", "physicalBytes"]),
})

const report: CalibrationValidationReport = {
	formatVersion: 1,
	configSha256: "", // filled by the caller (shell computes the SHA)
	configName: "",
	trial: { generationId: genId, signal, rangeStart: "", archivedRowCount: rows, shardCount: shards },
	comparison,
	measuredAt: new Date().toISOString(),
}

// Emit the comparison summary to stderr for the probe log, the report to stdout.
for (const c of comparison.comparisons) {
	process.stderr.write(
		`  ${c.metric.padEnd(28)} predicted=${c.predicted} observed=${c.observed} ` +
			`delta=${c.relativeDelta.toFixed(3)} tol=${c.tolerance} ${c.withinTolerance ? "OK" : "FAIL"}\n`,
	)
}
process.stderr.write(`  verdict: ${comparison.passed ? "PASS" : "FAIL"}\n`)

// Emit the report as JSON to stdout (the caller reads it).
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)

if (!comparison.passed) process.exit(1)
