import { Effect, Option, Schema } from "effect"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import * as Argument from "effect/unstable/cli/Argument"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { createArchiveGeneration, runArchiveReconciliation } from "../server/archives/generation"
import {
	listActiveGenerations,
	activeParquetPaths,
	rebuildCatalogWithMaintenanceLock,
	verifyActiveGenerations,
} from "../server/archives/listing"
import { runArchiveGc } from "../server/archives/gc"
import {
	resolveArchiveTuning,
	loadTuningConfig,
	TUNING_CONFIG_FORMAT_VERSION,
	type ArchiveTuningOverrides,
	type TuningConfigIdentity,
	type LoadedTuningConfig,
} from "../server/archives/config"
import { ARCHIVE_SIGNALS, isArchiveSignalName, type ArchiveSignalName } from "../server/archives/signals"
import { validateRangeDate } from "../server/archives/paths"
import {
	type CalibrationBudget,
	type CalibrationCandidate,
	type CandidateMetrics,
	type CandidateResult,
	CANDIDATE_MATRIX,
	captureEnvironment,
	meetsCeilings,
	recommendationToTuning,
	selectCandidates,
	writeCalibrationConfig,
	type CalibrationRecommendation,
	HELD_OUT_TOLERANCES,
	isSameCalibrationCandidate,
	heldOutSampleRows,
	compareHeldOutPerSignal,
	validateCalibrationBudget,
} from "../server/archives/calibrate"
import {
	preflightCalibrationFreeSpace,
	reconcileCalibration,
	writeCalibrationRecord,
	directoryTreeBytes,
	archiveVolumeIdentity,
	derivedSampleDir,
	derivedScratchSubdir,
	calibrationPinPurpose,
	assertCalibrationSession,
	cleanupCalibrationSample,
} from "../server/archives/calibration-recovery"
import {
	acquireCheckpointPin,
	parseCheckpointSelector,
	resolveCheckpoint,
	withMaintenanceLock,
	withRestoredCheckpoint,
} from "../server/checkpoints"
import {
	captureSourceSchema,
	exportShardPlans,
	planCalibrationShards,
	measureShardBytes,
	type ExportSettings,
} from "../server/archives/export"
import { archiveSignal } from "../server/archives/signals"
import { ensurePrivateDirectory } from "../server/archives/paths"
import { CHDB_VERSION, MAPLE_VERSION } from "../version"
import { SCHEMA_FINGERPRINT } from "../server/serve"
import { amber, bold, dim, green, red } from "../lib/style"
import {
	collectChildOutputAfterClose,
	createTimeReport,
	parsePeakRss,
	timeArgv,
} from "../server/archives/timed-process"
import { ArchiveError } from "../server/archives/errors"

const defaultDataDir = (): string => join(homedir(), ".maple", "data")
const defaultArchiveDir = (): string => join(homedir(), ".maple", "archive")
const defaultScratchRoot = (): string => join(homedir(), ".maple", "scratch")

const prettyPath = (p: string): string => {
	const home = homedir()
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p
}

const dataDirFlag = Flag.optional(
	Flag.string("data-dir").pipe(
		Flag.withDescription("Embedded ClickHouse data directory (default: ~/.maple/data)"),
	),
)

const archiveDirFlag = Flag.optional(
	Flag.string("archive-dir").pipe(
		Flag.withDescription("Archive root directory for Parquet generations (default: ~/.maple/archive)"),
	),
)

const scratchRootFlag = Flag.optional(
	Flag.string("scratch-root").pipe(
		Flag.withDescription("Root for restored-checkpoint scratch instances (default: ~/.maple/scratch)"),
	),
)

const checkpointIdFlag = Flag.optional(
	Flag.string("checkpoint-id").pipe(
		Flag.withDescription("Archive from one immutable checkpoint ID instead of the selected current"),
	),
)

const dryRunFlag = Flag.boolean("dry-run").pipe(
	Flag.withDescription("Report the exact planned actions without modifying any archive state"),
	Flag.withDefault(false),
)

const keepFlag = Flag.integer("keep").pipe(
	Flag.withDescription(
		"Newest superseded generations to retain per signal/range (default 1; 0 reclaims all superseded)",
	),
	Flag.withDefault(1),
)

const memoryBudgetFlag = Flag.integer("memory-budget").pipe(
	Flag.withDescription("Maximum peak RSS in bytes allowed for any calibration candidate"),
	Flag.withDefault(512 * 1024 * 1024),
)

const timeBudgetFlag = Flag.integer("time-budget").pipe(
	Flag.withDescription("Maximum wall-clock milliseconds for the full calibration matrix"),
	Flag.withDefault(60_000),
)

const sampleRowsFlag = Flag.integer("sample-rows").pipe(
	Flag.withDescription("Rows to sample per calibration candidate"),
	Flag.withDefault(10_000),
)

const writeConfigFlag = Flag.optional(
	Flag.string("write-config").pipe(
		Flag.withDescription("Write the generated tuning configuration to this path"),
	),
)

const configFlag = Flag.optional(
	Flag.string("config").pipe(
		Flag.withDescription(
			"Load tuning overrides from a versioned calibration config document (see: archive calibrate --write-config)",
		),
	),
)

const maxCandidateWallMsFlag = Flag.integer("max-candidate-wall-ms").pipe(
	Flag.withDescription("Maximum wall-clock milliseconds for a single calibration candidate run"),
	Flag.withDefault(30_000),
)

const minThroughputFlag = Flag.integer("min-throughput").pipe(
	Flag.withDescription("Minimum logical write throughput in bytes/sec required of a candidate"),
	Flag.withDefault(0),
)

const maxTempDiskFlag = Flag.integer("max-temp-disk").pipe(
	Flag.withDescription("Maximum peak temporary disk (restored scratch + sample output) in bytes"),
	Flag.withDefault(2 * 1024 * 1024 * 1024),
)

const freeSpaceReserveFlag = Flag.integer("free-space-reserve").pipe(
	Flag.withDescription("Minimum free-space reserve on the archive volume in bytes before calibrating"),
	Flag.withDefault(512 * 1024 * 1024),
)

const safetyMarginFlag = Flag.integer("safety-margin-milli").pipe(
	Flag.withDescription(
		"Safety margin in thousandths applied inside each ceiling (e.g. 1100 = 1.1x, reserving 10% headroom)",
	),
	Flag.withDefault(1100),
)

const writerThreadsFlag = Flag.integer("writer-threads").pipe(
	Flag.withDescription("Parquet writer thread count for a calibration run"),
	Flag.withDefault(1),
)

const rowGroupRowsFlag = Flag.integer("row-group-rows").pipe(
	Flag.withDescription("Parquet row-group row count for a calibration run"),
	Flag.withDefault(10_000),
)

const maxShardRowsFlag = Flag.integer("max-shard-rows").pipe(
	Flag.withDescription("Maximum rows per shard for a calibration run"),
	Flag.withDefault(500_000),
)

const maxShardBytesFlag = Flag.integer("max-shard-bytes").pipe(
	Flag.withDescription("Maximum estimated bytes per shard for a calibration run"),
	Flag.withDefault(256 * 1024 * 1024),
)

const rangeDateArgument = Argument.string("range-date").pipe(
	Argument.withDescription("UTC day to seal as YYYY-MM-DD"),
)

const signalArgument = Argument.string("signal").pipe(
	Argument.withDescription(`One of: ${ARCHIVE_SIGNALS.map((s) => s.name).join(", ")}`),
)

const outputFlag = Flag.choice("output", ["summary", "paths", "json"]).pipe(
	Flag.withDescription(
		"Output format: summary (default), paths (machine-readable active Parquet paths), or json",
	),
	Flag.withDefault("summary" as const),
)

/** Build tuning overrides from parsed flags. */
const tuningOverrides = (archiveDir: string, scratchRoot: string): ArchiveTuningOverrides =>
	({ archiveDir, scratchRoot }) satisfies ArchiveTuningOverrides

/** Resolve the archive and scratch roots from flags, falling back to defaults. */
const resolveRoots = (
	dataDirOpt: Option.Option<string>,
	archiveDirOpt: Option.Option<string>,
	scratchRootOpt: Option.Option<string>,
): { dataDir: string; archiveDir: string; scratchRoot: string } => ({
	dataDir: resolve(Option.getOrUndefined(dataDirOpt) ?? defaultDataDir()),
	archiveDir: resolve(Option.getOrUndefined(archiveDirOpt) ?? defaultArchiveDir()),
	scratchRoot: resolve(Option.getOrUndefined(scratchRootOpt) ?? defaultScratchRoot()),
})

export const archiveCreate = Command.make("create", {
	dataDir: dataDirFlag,
	archiveDir: archiveDirFlag,
	scratchRoot: scratchRootFlag,
	checkpointId: checkpointIdFlag,
	config: configFlag,
	rangeDate: rangeDateArgument,
	signal: signalArgument,
}).pipe(
	Command.withDescription(
		"Seal one UTC day of one signal into a validated Parquet archive generation from a checkpoint",
	),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			if (!isArchiveSignalName(a.signal)) {
				return yield* new ArchiveError({
					message: `unknown signal '${a.signal}'; expected one of ${ARCHIVE_SIGNALS.map((s) => s.name).join(", ")}`,
				})
			}
			let rangeDate: string
			try {
				rangeDate = validateRangeDate(a.rangeDate)
			} catch (error) {
				return yield* new ArchiveError({
					message: error instanceof Error ? error.message : String(error),
				})
			}
			const { dataDir, archiveDir, scratchRoot } = resolveRoots(a.dataDir, a.archiveDir, a.scratchRoot)
			const checkpointId = Option.getOrUndefined(a.checkpointId)
			// Resolve tuning. Precedence: explicit CLI tuning flags > config-file
			// effective values > defaults. A --config document is loaded from one fd
			// (SHA-256-bound) and its effective values become the override base; the
			// config identity is recorded in the manifest so the generation is
			// reproducible. archive create does not yet expose per-knob CLI flags,
			// so config-file values override defaults directly; conflicting root
			// overrides (archiveDir/scratchRoot in config) are not applied — roots
			// always come from the CLI/defaults.
			const configPath = Option.getOrUndefined(a.config)
			let tuning
			let tuningConfigIdentity: TuningConfigIdentity | null = null
			let loadedTuningConfig: LoadedTuningConfig | null = null
			try {
				if (configPath) {
					const loaded = loadTuningConfig(configPath)
					loadedTuningConfig = loaded
					tuningConfigIdentity = loaded.identity
					tuning = resolveArchiveTuning({ ...loaded.overrides, archiveDir, scratchRoot })
				} else {
					tuning = resolveArchiveTuning(tuningOverrides(archiveDir, scratchRoot))
				}
			} catch (error) {
				return yield* new ArchiveError({
					message: error instanceof Error ? error.message : String(error),
				})
			}
			yield* Effect.sync(() =>
				process.stderr.write(
					`${amber("⟳")} archiving ${bold(a.signal)} for ${bold(rangeDate)} ` +
						`from ${prettyPath(dataDir)}` +
						(tuningConfigIdentity ? ` (config ${tuningConfigIdentity.configName})` : "") +
						`\n`,
				),
			)
			const result = yield* Effect.tryPromise({
				try: () =>
					createArchiveGeneration(
						dataDir,
						archiveDir,
						a.signal,
						rangeDate,
						tuning,
						checkpointId ?? "current",
						{},
						loadedTuningConfig,
					),
				catch: (error) =>
					new ArchiveError({ message: error instanceof Error ? error.message : String(error) }),
			})
			yield* Effect.sync(() =>
				process.stdout.write(
					`${green("✓")} archive generation sealed\n` +
						`  ${dim("signal")}       ${result.signal}\n` +
						`  ${dim("range")}        ${result.rangeStart}\n` +
						`  ${dim("generation")}   ${result.generationId}\n` +
						`  ${dim("shards")}       ${result.shardCount}\n` +
						`  ${dim("rows")}         ${result.archivedRowCount}\n` +
						`  ${dim("archive-dir")}  ${prettyPath(archiveDir)}\n` +
						`  ${dim("scratch-root")} ${prettyPath(scratchRoot)}\n` +
						`  ${dim("effective")}    t=${tuning.writerThreads} rg=${tuning.rowGroupRows} ` +
						`msr=${tuning.maxShardRows} msb=${tuning.maxShardBytes} ` +
						`tc=${tuning.targetChunkBytes} reserve=${tuning.minFreeSpaceReserve}\n` +
						(tuningConfigIdentity
							? `  ${dim("config")}       ${tuningConfigIdentity.configName} (${tuningConfigIdentity.sha256})\n`
							: "") +
						(result.superseded ? `  ${dim("superseded")} ${result.superseded}\n` : ""),
				),
			)
		}),
	),
)

const signalFlag = Flag.optional(
	Flag.string("signal").pipe(
		Flag.withDescription(`One of: ${ARCHIVE_SIGNALS.map((s) => s.name).join(", ")}`),
	),
)

export const archiveList = Command.make("list", {
	archiveDir: archiveDirFlag,
	output: outputFlag,
	signal: signalFlag,
}).pipe(
	Command.withDescription(
		"List active archive metadata and Parquet shard paths without hashing shard contents",
	),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const archiveDir = Option.getOrUndefined(a.archiveDir) ?? defaultArchiveDir()
			if (a.output === "paths") {
				const signalOpt = Option.getOrUndefined(a.signal)
				if (!signalOpt || !isArchiveSignalName(signalOpt)) {
					return yield* new ArchiveError({
						message: `--output paths requires a signal argument; expected one of ${ARCHIVE_SIGNALS.map((s) => s.name).join(", ")}`,
					})
				}
				const paths = yield* Effect.try({
					try: () => activeParquetPaths(archiveDir, signalOpt),
					catch: (error) =>
						new ArchiveError({
							operation: "list paths",
							message: error instanceof Error ? error.message : String(error),
							cause: error instanceof Error ? error.stack : undefined,
						}),
				})
				yield* Effect.sync(() => process.stdout.write(`${paths.map((p) => `"${p}"`).join(",")}\n`))
				return
			}
			const listing = yield* Effect.try({
				try: () => listActiveGenerations(archiveDir),
				catch: (error) =>
					new ArchiveError({
						operation: "list",
						message: error instanceof Error ? error.message : String(error),
						cause: error instanceof Error ? error.stack : undefined,
					}),
			})
			if (a.output === "json") {
				yield* Effect.sync(() => process.stdout.write(`${JSON.stringify(listing, null, 2)}\n`))
				return
			}
			if (listing.errors.length > 0) {
				const detail = listing.errors
					.map((error) => `${error.signal}/${error.rangeStart || "(root)"}: ${error.error}`)
					.join("; ")
				return yield* new ArchiveError({
					operation: "list summary",
					message: `refusing archive summary because ${listing.errors.length} malformed range(s) were found: ${detail}`,
				})
			}
			if (listing.active.length === 0) {
				yield* Effect.sync(() =>
					process.stderr.write(`No active archive generations in ${prettyPath(archiveDir)}\n`),
				)
				return
			}
			const lines = listing.active.map(
				(summary) =>
					`  ${dim(summary.signal.padEnd(34))} ${summary.rangeStart}  ` +
					`${summary.archivedRowCount.toString().padStart(10)} rows  ` +
					`${summary.shardCount} shards  ${summary.generationId.slice(0, 8)}`,
			)
			yield* Effect.sync(() =>
				process.stdout.write(
					`${green("✓")} ${listing.active.length} active generation(s) in ${prettyPath(archiveDir)} ` +
						`(metadata only; run 'maple archive verify' for SHA-256)\n${lines.join("\n")}\n`,
				),
			)
		}),
	),
)

export const archiveVerify = Command.make("verify", {
	archiveDir: archiveDirFlag,
	signal: signalFlag,
}).pipe(
	Command.withDescription("Stream and SHA-256 verify active archive shards with bounded memory"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const archiveDir = Option.getOrUndefined(a.archiveDir) ?? defaultArchiveDir()
			const signalOpt = Option.getOrUndefined(a.signal)
			if (signalOpt !== undefined && !isArchiveSignalName(signalOpt)) {
				return yield* new ArchiveError({
					message: `unknown signal '${signalOpt}'; expected one of ${ARCHIVE_SIGNALS.map((s) => s.name).join(", ")}`,
				})
			}
			const result = yield* Effect.tryPromise({
				try: () => verifyActiveGenerations(archiveDir, signalOpt),
				catch: (error) =>
					new ArchiveError({ message: error instanceof Error ? error.message : String(error) }),
			})
			yield* Effect.sync(() =>
				process.stdout.write(
					`${green("✓")} verified ${result.shardCount} active shard(s) across ` +
						`${result.generationCount} generation(s) (${formatBytes(result.verifiedBytes)})\n`,
				),
			)
		}),
	),
)

export const archiveRebuild = Command.make("rebuild", {
	dataDir: dataDirFlag,
	archiveDir: archiveDirFlag,
	signal: signalArgument,
}).pipe(
	Command.withDescription("Rebuild a signal's catalog.jsonl from authoritative generation manifests"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			if (!isArchiveSignalName(a.signal)) {
				return yield* new ArchiveError({
					message: `unknown signal '${a.signal}'; expected one of ${ARCHIVE_SIGNALS.map((s) => s.name).join(", ")}`,
				})
			}
			const dataDir = resolve(Option.getOrUndefined(a.dataDir) ?? defaultDataDir())
			const archiveDir = resolve(Option.getOrUndefined(a.archiveDir) ?? defaultArchiveDir())
			const signalName: ArchiveSignalName = a.signal
			const entries = yield* Effect.tryPromise({
				try: () => rebuildCatalogWithMaintenanceLock(dataDir, archiveDir, signalName, randomUUID()),
				catch: (error) =>
					new ArchiveError({
						operation: "rebuild catalog",
						message: error instanceof Error ? error.message : String(error),
						cause: error instanceof Error ? error.stack : undefined,
					}),
			})
			yield* Effect.sync(() =>
				process.stdout.write(
					`${green("✓")} rebuilt ${a.signal} catalog with ${entries.length} generation(s)\n`,
				),
			)
		}),
	),
)

export const archiveReconcile = Command.make("reconcile", {
	dataDir: dataDirFlag,
	archiveDir: archiveDirFlag,
	scratchRoot: scratchRootFlag,
	dryRun: dryRunFlag,
}).pipe(
	Command.withDescription(
		"Reconcile an interrupted archive create or gc operation to its intended state without a fresh export",
	),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const { dataDir, archiveDir, scratchRoot } = resolveRoots(a.dataDir, a.archiveDir, a.scratchRoot)
			// Both dry-run and apply go through the locked runArchiveReconciliation
			// entry point (blocker 2): dry-run returns the plan without mutating;
			// apply acquires the maintenance lock, migrates any v2 intent, then
			// reconciles — never racing create/GC planning or pointer/catalog repair.
			const decision = yield* Effect.tryPromise({
				try: () => runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: a.dryRun }),
				catch: (error) =>
					new ArchiveError({ message: error instanceof Error ? error.message : String(error) }),
			})
			const renderDecision = (d: typeof decision): string => {
				if (d.kind === "NoOp") return `${green("✓")} reconcile: no active operation\n`
				if (d.kind === "FailClosed") return `${red("!")} FAIL CLOSED: ${d.reason}\n`
				const id = "operationId" in d ? d.operationId : ""
				const mig = "migrationRequired" in d && d.migrationRequired ? " (migrate v2)" : ""
				return `${green("✓")} reconcile ${d.kind}: ${id}${mig}\n`
			}
			if (a.dryRun) {
				if (decision.kind === "FailClosed") {
					return yield* new ArchiveError({ message: renderDecision(decision).trim() })
				}
				yield* Effect.sync(() =>
					process.stdout.write(
						`${amber("◌")} dry-run reconcile\n${renderDecision(decision)}  ${dim("archive")}   ${prettyPath(archiveDir)}\n  ${dim("note")}     no archive state is modified\n`,
					),
				)
				return
			}
			if (decision.kind === "FailClosed") {
				return yield* new ArchiveError({ message: renderDecision(decision).trim() })
			}
			yield* Effect.sync(() =>
				process.stderr.write(
					`${amber("⟳")} reconciling interrupted archive operation in ${prettyPath(archiveDir)}\n`,
				),
			)
			yield* Effect.sync(() => process.stdout.write(renderDecision(decision)))
		}),
	),
)

export const archiveGc = Command.make("gc", {
	dataDir: dataDirFlag,
	archiveDir: archiveDirFlag,
	scratchRoot: scratchRootFlag,
	keep: keepFlag,
	dryRun: dryRunFlag,
}).pipe(
	Command.withDescription(
		"Reclaim superseded archive generations, retaining the newest N per signal/range (default 1)",
	),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			if (!Number.isSafeInteger(a.keep) || a.keep < 0) {
				return yield* new ArchiveError({
					message: `invalid --keep value: ${a.keep} (must be a non-negative integer)`,
				})
			}
			const { dataDir, archiveDir, scratchRoot } = resolveRoots(a.dataDir, a.archiveDir, a.scratchRoot)
			const result = yield* Effect.tryPromise({
				try: () => runArchiveGc({ dataDir, archiveDir, scratchRoot, keep: a.keep, dryRun: a.dryRun }),
				catch: (error) =>
					new ArchiveError({ message: error instanceof Error ? error.message : String(error) }),
			})
			const { plan } = result
			if (a.dryRun) {
				yield* Effect.sync(() =>
					process.stdout.write(
						`${amber("◌")} dry-run gc: would delete ${plan.deleteSet.length} generation(s), ` +
							`reclaim ${formatBytes(plan.reclaimableBytes)}\n` +
							`  ${dim("keep")}        ${plan.keep} newest superseded per range\n` +
							(plan.deleteSet.length === 0
								? `  ${dim("note")}      nothing to reclaim\n`
								: plan.deleteSet
										.map(
											(c) =>
												`  ${dim("delete")}    ${c.signal}/${c.rangeStart}/${c.generationId} (${formatBytes(c.bytes)})`,
										)
										.join("\n") + "\n") +
							(plan.excludedSignals.length + plan.excludedRanges.length === 0
								? ""
								: `${red("!")} ${plan.excludedSignals.length + plan.excludedRanges.length} range(s)/signal(s) excluded (over-retained)\n`),
					),
				)
				return
			}
			yield* Effect.sync(() =>
				process.stdout.write(
					`${green("✓")} gc complete: deleted ${result.deleted.length} generation(s), ` +
						`reclaimed ${formatBytes(plan.reclaimableBytes)}\n` +
						`  ${dim("kept")}        ${plan.keep} newest superseded per range\n`,
				),
			)
		}),
	),
)

const formatBytes = (bytes: number): string => {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}

const pauseAtSessionPhaseFlag = Flag.optional(
	Flag.string("pause-at-session-phase").pipe(
		Flag.withDescription("TEST ONLY: pause after durable-writing the parent session phase"),
	),
)
const sessionMarkerDirFlag = Flag.optional(
	Flag.string("session-marker-dir").pipe(
		Flag.withDescription("TEST ONLY: marker directory for parent-session pause"),
	),
)

type CalibrationSelection = NonNullable<CalibrationRecommendation["selected"]>

/** Require a successful calibration recommendation through Effect's typed
 * error channel. Keeping this check outside Effect.sync prevents an expected
 * calibration failure from becoming an unhandled fiber defect. */
export const requireCalibrationSelection = (
	recommendation: Pick<CalibrationRecommendation, "selected" | "note">,
): Effect.Effect<CalibrationSelection, ArchiveError> =>
	recommendation.selected === null
		? Effect.fail(
				new ArchiveError({
					message: `${red("!")} calibration did not produce a recommendation: ${recommendation.note}`,
				}),
			)
		: Effect.succeed(recommendation.selected)

export const archiveCalibrate = Command.make("calibrate", {
	dataDir: dataDirFlag,
	archiveDir: archiveDirFlag,
	scratchRoot: scratchRootFlag,
	checkpointId: checkpointIdFlag,
	rangeDate: rangeDateArgument,
	memoryBudget: memoryBudgetFlag,
	timeBudget: timeBudgetFlag,
	sampleRows: sampleRowsFlag,
	maxCandidateWallMs: maxCandidateWallMsFlag,
	minThroughput: minThroughputFlag,
	maxTempDisk: maxTempDiskFlag,
	freeSpaceReserve: freeSpaceReserveFlag,
	safetyMarginMilli: safetyMarginFlag,
	writeConfig: writeConfigFlag,
	pauseAtSessionPhase: pauseAtSessionPhaseFlag,
	sessionMarkerDir: sessionMarkerDirFlag,
}).pipe(
	Command.withDescription(
		"Calibrate archive tuning by running a candidate matrix against a pinned checkpoint across all six signals",
	),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			let rangeDate: string
			try {
				rangeDate = validateRangeDate(a.rangeDate)
			} catch (error) {
				return yield* new ArchiveError({
					message: error instanceof Error ? error.message : String(error),
				})
			}
			let budget: CalibrationBudget
			try {
				budget = validateCalibrationBudget({
					memoryBudget: a.memoryBudget,
					timeBudget: a.timeBudget,
					sampleRows: a.sampleRows,
					maxCandidateWallMs: a.maxCandidateWallMs,
					minThroughputBytesPerSec: a.minThroughput,
					maxTempDiskBytes: a.maxTempDisk,
					freeSpaceReserve: a.freeSpaceReserve,
					safetyMargin: a.safetyMarginMilli / 1000,
				})
			} catch (error) {
				return yield* new ArchiveError({
					message: error instanceof Error ? error.message : String(error),
				})
			}
			const { dataDir, archiveDir, scratchRoot } = resolveRoots(a.dataDir, a.archiveDir, a.scratchRoot)
			const checkpointId = Option.getOrUndefined(a.checkpointId) ?? "current"
			yield* Effect.sync(() =>
				process.stderr.write(
					`${amber("⟳")} calibrating all six signals for ${bold(rangeDate)} ` +
						`(memory ${a.memoryBudget}B, time ${a.timeBudget}ms, sample ${a.sampleRows} rows, ` +
						`margin ${budget.safetyMargin.toFixed(3)}x)\n`,
				),
			)
			// Run the candidate matrix across all six signals. Each candidate x
			// signal combination is a fresh calibrate-run child spawned under
			// /usr/bin/time so peak RSS is measured externally. A per-child watchdog
			// enforces the candidate wall deadline and temp-disk ceiling DURING the
			// run (SIGKILL on overrun -> candidate marked failed).
			const rec = yield* Effect.tryPromise({
				try: () =>
					runCalibrationMatrix(
						process.execPath,
						dataDir,
						checkpointId,
						rangeDate,
						scratchRoot,
						archiveDir,
						budget,
						{
							pauseAtPhase: Option.getOrUndefined(a.pauseAtSessionPhase),
							markerDir: Option.getOrUndefined(a.sessionMarkerDir),
						},
					),
				catch: (error) =>
					new ArchiveError({ message: error instanceof Error ? error.message : String(error) }),
			})
			if (
				Option.getOrUndefined(a.pauseAtSessionPhase) === "post-session-release" &&
				Option.getOrUndefined(a.sessionMarkerDir)
			) {
				const markerDir = Option.getOrUndefined(a.sessionMarkerDir)!
				yield* Effect.tryPromise({
					try: async () => {
						const { mkdirSync, writeFileSync } = await import("node:fs")
						mkdirSync(markerDir, { recursive: true })
						writeFileSync(
							join(markerDir, "paused"),
							`post-session-release\n${process.pid}\n${new Date().toISOString()}\n`,
						)
						await new Promise<void>(() => {
							/* deterministic SIGKILL seam after reconcile, before config/no-config publication */
						})
					},
					catch: (error) =>
						new ArchiveError({
							message: error instanceof Error ? error.message : String(error),
						}),
				})
			}
			yield* Effect.sync(() => {
				for (const r of rec.results) {
					const status = r.ok && r.metrics ? `${r.metrics.peakRssBytes}B RSS` : `FAIL: ${r.error}`
					process.stderr.write(
						`  ${dim(`${r.signal} t=${r.candidate.writerThreads} rg=${r.candidate.rowGroupRows}`)}  ${status}\n`,
					)
				}
			})
			const selected = yield* requireCalibrationSelection(rec)
			const tuning = recommendationToTuning(rec, archiveDir, scratchRoot)
			const writePath = Option.getOrUndefined(a.writeConfig)
			if (writePath) {
				yield* Effect.try({
					try: () => writeCalibrationConfig(writePath, rec, tuning),
					catch: (error) =>
						new ArchiveError({ message: error instanceof Error ? error.message : String(error) }),
				})
				yield* Effect.sync(() =>
					process.stdout.write(
						`${green("✓")} calibration ${rec.confidence} confidence; config written to ${writePath}\n` +
							`  ${dim("selected")} t=${selected.candidate.writerThreads} ` +
							`rg=${selected.candidate.rowGroupRows} rss=${selected.worstCase.peakRssBytes}B\n` +
							`  ${dim("margin")}      ${budget.safetyMargin.toFixed(3)}x applied inside each ceiling\n`,
					),
				)
			} else {
				yield* Effect.sync(() =>
					process.stdout.write(
						`${green("✓")} calibration ${rec.confidence} confidence\n` +
							`  ${dim("selected")} t=${selected.candidate.writerThreads} ` +
							`rg=${selected.candidate.rowGroupRows} rss=${selected.worstCase.peakRssBytes}B\n` +
							`  ${dim("note")} pass --write-config <path> to apply\n`,
					),
				)
			}
		}),
	),
)

/**
 * The metrics line printed by calibrate-run children and parsed by the parent.
 * `exportWallMs` is the wall time of the calibrated export section only (not
 * process-launch-to-exit), so write throughput is export-throughput, not
 * end-to-end.
 */
const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const NonNegativeSafeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const ChildMetricsSchema = Schema.Struct({
	logicalBytes: NonNegativeFinite,
	physicalBytes: NonNegativeFinite,
	peakTempDiskBytes: NonNegativeFinite,
	peakRssBytes: NonNegativeFinite,
	exportWallMs: NonNegativeFinite,
	rowCount: NonNegativeSafeInteger,
	sample: Schema.Struct({
		checkpointId: Schema.String,
		checkpointManifestFingerprint: Schema.String,
		rangeDate: Schema.String,
		role: Schema.Literals(["training", "held-out"]),
		startRow: NonNegativeSafeInteger,
		requestedRows: NonNegativeSafeInteger,
		rowCount: NonNegativeSafeInteger,
	}),
})

type ChildMetrics = typeof ChildMetricsSchema.Type

export interface ExpectedChildSampleScope {
	readonly checkpointId: string
	readonly checkpointManifestFingerprint: string
	readonly rangeDate: string
	readonly role: "training" | "held-out"
	readonly startRow: number
	readonly requestedRows: number
}

/** Decode the child protocol exactly and bind its authoritative sample scope
 * to the request that the parent actually sent. */
export const decodeChildMetrics = (input: unknown, expected: ExpectedChildSampleScope): ChildMetrics => {
	const raw = Schema.decodeUnknownSync(ChildMetricsSchema, { onExcessProperty: "error" })(input)
	const sample = raw.sample
	if (
		sample.checkpointId !== expected.checkpointId ||
		sample.checkpointManifestFingerprint !== expected.checkpointManifestFingerprint ||
		sample.rangeDate !== expected.rangeDate ||
		sample.role !== expected.role ||
		sample.startRow !== expected.startRow ||
		sample.requestedRows !== expected.requestedRows ||
		sample.rowCount !== raw.rowCount
	) {
		throw new Error("calibrate-run emitted an inconsistent sample scope")
	}
	return raw
}

/**
 * Run one calibrate-run child under /usr/bin/time in a DEDICATED PROCESS GROUP
 * so peak RSS is measured externally and the watchdog can kill the entire
 * group (Maple descendant included). The watchdog uses the MINIMUM of the
 * remaining total budget and the per-candidate wallMs. During the run, the
 * parent POLLS the exact derived scratch/sample paths for temp-disk usage and
 * kills the group on overrun (fail-loud: read/symlink/special-file errors fail
 * the candidate). Peak RSS is FAIL-CLOSED: unparseable /usr/bin/time output
 * fails the candidate (no completion-RSS fallback).
 */
const runCandidateChild = (
	bundlePath: string,
	dataDir: string,
	checkpointId: string,
	checkpointManifestFingerprint: string,
	rangeDate: string,
	signal: string,
	scratchRoot: string,
	archiveDir: string,
	candidate: CalibrationCandidate,
	budget: CalibrationBudget,
	operationId: string,
	startRow: number,
	sampleRows: number,
	matrixStart: number,
): Promise<CandidateResult> => {
	return new Promise((resolvePromise) => {
		// Bun creates nonblocking stdio pipes for spawned children. GNU/BSD `time`
		// writes a large multi-line report on exit, and that report can fail with
		// EAGAIN when directed at the inherited stderr pipe. Write it to an
		// independent temporary file instead; stderr remains available for real
		// worker diagnostics and the report is removed after this one child closes.
		let timeReport: ReturnType<typeof createTimeReport>
		try {
			timeReport = createTimeReport()
		} catch (error) {
			resolvePromise({
				candidate,
				signal,
				metrics: null,
				ok: false,
				error: `failed to create time-report directory: ${error instanceof Error ? error.message : String(error)}`,
			})
			return
		}
		const args = [
			"archive",
			"calibrate-run",
			signal,
			rangeDate,
			"--data-dir",
			dataDir,
			"--archive-dir",
			archiveDir,
			"--scratch-root",
			scratchRoot,
			"--checkpoint-id",
			checkpointId,
			"--checkpoint-fingerprint",
			checkpointManifestFingerprint,
			"--operation-id",
			operationId,
			"--start-row",
			String(startRow),
			"--sample-rows",
			String(sampleRows),
			"--max-temp-disk",
			String(budget.maxTempDiskBytes),
			"--free-space-reserve",
			String(budget.freeSpaceReserve),
			"--writer-threads",
			String(candidate.writerThreads),
			"--row-group-rows",
			String(candidate.rowGroupRows),
			"--max-shard-rows",
			String(candidate.maxShardRows),
			"--max-shard-bytes",
			String(candidate.maxShardBytes),
		]
		// Spawn under /usr/bin/time in its own process group so the watchdog can
		// kill the whole group (Maple descendant included), not just /usr/bin/time.
		const child = spawn("/usr/bin/time", [...timeArgv(), "-o", timeReport.path, bundlePath, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		})
		const childOutput = collectChildOutputAfterClose(child)
		const pgid = child.pid ?? 0
		let killedByWatchdog = false
		let killReason = ""
		let settled = false
		const finish = (result: CandidateResult) => {
			if (settled) return
			settled = true
			resolvePromise(result)
		}
		// Watchdog deadline = min(remaining total budget, per-candidate wallMs).
		const remaining = budget.timeBudget - (Date.now() - matrixStart)
		const deadline = Math.max(1000, Math.min(budget.maxCandidateWallMs, remaining))
		// The exact derived paths the parent polls for temp-disk enforcement.
		const pollScratch = resolve(scratchRoot, `calibrate-${operationId}`)
		const pollSample = resolve(archiveDir, "calibration", "samples", operationId)
		const killGroup = (reason: string) => {
			killedByWatchdog = true
			killReason = reason
			try {
				process.kill(-pgid, "SIGKILL")
			} catch {
				try {
					child.kill("SIGKILL")
				} catch {
					// best-effort
				}
			}
		}
		const watchdog = setTimeout(() => killGroup(`exceeded ${deadline}ms wall deadline`), deadline)
		// Poll temp-disk every 500ms during the run; kill on overrun. Read/symlink/
		// special-file errors fail-loud (kill the candidate).
		const diskPoll = setInterval(async () => {
			try {
				const sz = (await directoryTreeBytes(pollScratch)) + (await directoryTreeBytes(pollSample))
				if (sz * budget.safetyMargin > budget.maxTempDiskBytes) {
					clearInterval(diskPoll)
					killGroup(`exceeded ${budget.maxTempDiskBytes}B temp-disk ceiling (saw ${sz}B)`)
				}
			} catch (error) {
				clearInterval(diskPoll)
				killGroup(
					`temp-disk poll read error (fail-loud): ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}, 500)
		child.on("error", (error) => {
			clearTimeout(watchdog)
			clearInterval(diskPoll)
			timeReport.remove()
			finish({ candidate, signal, metrics: null, ok: false, error: error.message })
		})
		// `exit` fires before stdio has necessarily drained.  Wait for `close` so
		// the next candidate cannot start while this worker still owns its pipes,
		// and so failure reports include the complete worker diagnostics.
		void childOutput.then(({ code, stdout, stderr }) => {
			if (settled) return
			clearTimeout(watchdog)
			clearInterval(diskPoll)
			const timeOutput = timeReport.readAndRemove()
			if (killedByWatchdog) {
				finish({
					candidate,
					signal,
					metrics: null,
					ok: false,
					error: `candidate killed by watchdog: ${killReason}`,
				})
				return
			}
			// A nonzero exit means the child failed (export error OR cleanup
			// failure). The child emits its metrics JSON only after successful
			// cleanup; a JSON line present with a nonzero exit still means the
			// owned resources may not have been released. Treat nonzero as failure.
			if (code !== 0) {
				const fullDiagnostic = `${stderr}\n${stdout}\n${timeOutput.report}`
				const diagnostic =
					fullDiagnostic.length <= 1600
						? fullDiagnostic
						: `${fullDiagnostic.slice(0, 800)}\n… diagnostics truncated …\n${fullDiagnostic.slice(-800)}`
				finish({
					candidate,
					signal,
					metrics: null,
					ok: false,
					error: `calibrate-run exited ${code} (cleanup or export failure): ${diagnostic}${timeOutput.error ? `\n${timeOutput.error}` : ""}`,
				})
				return
			}
			// Peak RSS: FAIL-CLOSED. Unparseable /usr/bin/time output fails the
			// candidate (no completion-RSS fallback).
			const peakRssBytes =
				timeOutput.error === undefined ? parsePeakRss(timeOutput.report, process.platform) : null
			if (peakRssBytes === null) {
				finish({
					candidate,
					signal,
					metrics: null,
					ok: false,
					error: timeOutput.error
						? `${timeOutput.error} (fail-closed)`
						: `failed to parse peak RSS from /usr/bin/time report (fail-closed)`,
				})
				return
			}
			try {
				const lines = stdout.trim().split("\n")
				const parsed: unknown = JSON.parse(lines[lines.length - 1]!)
				const raw = decodeChildMetrics(parsed, {
					checkpointId,
					checkpointManifestFingerprint,
					rangeDate,
					role: startRow === 0 ? "training" : "held-out",
					startRow,
					requestedRows: sampleRows,
				})
				const logicalBytes = raw.logicalBytes
				const physicalBytes = raw.physicalBytes
				const compressionRatio = logicalBytes > 0 ? physicalBytes / logicalBytes : 0
				// Write throughput from the EXPORT section wall time, not process-launch-to-exit.
				const writeThroughputBytesPerSec =
					raw.exportWallMs > 0 ? logicalBytes / (raw.exportWallMs / 1000) : 0
				const metrics: CandidateMetrics = {
					logicalBytes,
					physicalBytes,
					compressionRatio,
					writeThroughputBytesPerSec,
					peakTempDiskBytes: raw.peakTempDiskBytes,
					peakRssBytes,
					wallMs: raw.exportWallMs,
					rowCount: raw.rowCount,
				}
				const sample = raw.sample
				finish({ candidate, signal, metrics, ok: true, sample })
			} catch (error) {
				finish({
					candidate,
					signal,
					metrics: null,
					ok: false,
					error: `failed to parse calibrate-run output: ${error instanceof Error ? error.message : String(error)}`,
				})
			}
		})
	})
}

/**
 * Run the full calibration matrix across all six signals, select the best
 * candidate by worst-case metrics, and validate it on a DISJOINT held-out
 * sample (row window [sampleRows, 2*sampleRows), not the training window
 * [0, sampleRows)). Requires complete six-signal evidence for eligibility and
 * held-out. Confidence "high" ⟺ a config is emitted; "low" ⟺ selected null
 * (small/unrepresentative data or insufficient disjoint held-out).
 */
const runCalibrationMatrix = async (
	bundlePath: string,
	dataDir: string,
	checkpointSelector: string,
	rangeDate: string,
	scratchRoot: string,
	archiveDir: string,
	budget: CalibrationBudget,
	faults: { pauseAtPhase?: string; markerDir?: string } = {},
): Promise<CalibrationRecommendation> => {
	if (!Number.isSafeInteger(budget.freeSpaceReserve) || budget.freeSpaceReserve <= 0) {
		throw new Error("calibration free-space reserve must be a positive integer")
	}
	const operationId = randomUUID()
	const pinId = randomUUID()
	const pinPurpose = calibrationPinPurpose(operationId)
	const scratchSubdir = derivedScratchSubdir(operationId)
	const sampleDir = derivedSampleDir(archiveDir, operationId)
	const roots = { dataDir, archiveDir, scratchRoot }
	const maybePauseSession = async (phase: string): Promise<void> => {
		if (faults.pauseAtPhase !== phase || !faults.markerDir) return
		const { mkdirSync, writeFileSync } = await import("node:fs")
		mkdirSync(faults.markerDir, { recursive: true })
		writeFileSync(
			join(faults.markerDir, "paused"),
			`${phase}\n${process.pid}\n${new Date().toISOString()}\n`,
		)
		await new Promise<void>(() => {
			/* deterministic SIGKILL seam */
		})
	}
	const session = await withMaintenanceLock(dataDir, operationId, async () => {
		await reconcileCalibration(archiveDir, roots)
		const resolved = await resolveCheckpoint(dataDir, parseCheckpointSelector(checkpointSelector))
		const manifestFingerprint = `${resolved.manifest.checkpointId}:${resolved.manifest.createdAt}:${resolved.manifest.backupBytes}`
		await writeCalibrationRecord(archiveDir, {
			phase: "intent",
			operationId,
			pinId,
			pinPurpose,
			pinPath: null,
			checkpointId: resolved.checkpointId,
			checkpointManifestFingerprint: manifestFingerprint,
			boundRoots: roots,
			ownedPaths: { scratchSubdir, sampleDir },
		})
		await maybePauseSession("intent")
		const pinPath = await acquireCheckpointPin(dataDir, resolved.checkpointId, pinPurpose, pinId)
		await writeCalibrationRecord(archiveDir, {
			phase: "pin-acquired",
			operationId,
			pinId,
			pinPurpose,
			pinPath,
			checkpointId: resolved.checkpointId,
			checkpointManifestFingerprint: manifestFingerprint,
			boundRoots: roots,
			ownedPaths: { scratchSubdir, sampleDir },
		})
		await maybePauseSession("pin-acquired")
		return { checkpointId: resolved.checkpointId, manifestFingerprint }
	})
	try {
		return await runBoundCalibrationMatrix(
			bundlePath,
			dataDir,
			session.checkpointId,
			session.manifestFingerprint,
			operationId,
			rangeDate,
			scratchRoot,
			archiveDir,
			budget,
		)
	} finally {
		await withMaintenanceLock(dataDir, operationId, () => reconcileCalibration(archiveDir, roots))
	}
}

const runBoundCalibrationMatrix = async (
	bundlePath: string,
	dataDir: string,
	checkpointId: string,
	checkpointManifestFingerprint: string,
	operationId: string,
	rangeDate: string,
	scratchRoot: string,
	archiveDir: string,
	budget: CalibrationBudget,
): Promise<CalibrationRecommendation> => {
	const volId = await archiveVolumeIdentity(archiveDir)
	const environment = captureEnvironment(MAPLE_VERSION, CHDB_VERSION, SCHEMA_FINGERPRINT, archiveDir, volId)
	const allResults: CandidateResult[] = []
	const perSignal = new Map<CalibrationCandidate, CandidateResult[]>()
	const matrixStart = Date.now()
	for (const signal of ARCHIVE_SIGNALS) {
		for (const candidate of CANDIDATE_MATRIX) {
			if (Date.now() - matrixStart > budget.timeBudget) break
			const result = await runCandidateChild(
				bundlePath,
				dataDir,
				checkpointId,
				checkpointManifestFingerprint,
				rangeDate,
				signal.name,
				scratchRoot,
				archiveDir,
				candidate,
				budget,
				operationId,
				0,
				budget.sampleRows,
				matrixStart,
			)
			allResults.push(result)
			const list = perSignal.get(candidate) ?? []
			list.push(result)
			perSignal.set(candidate, list)
		}
		if (Date.now() - matrixStart > budget.timeBudget) break
	}
	// Select eligible candidates requiring EXACTLY six signals each.
	const requiredSignals = ARCHIVE_SIGNALS.map((s) => s.name)
	const eligible = selectCandidates(perSignal, budget, requiredSignals)
	let selected: { candidate: CalibrationCandidate; worstCase: CandidateMetrics } | null = null
	let selectedHeldOut: CalibrationRecommendation["heldOut"] = null
	const heldOutAttempts: CalibrationRecommendation["heldOutAttempts"][number][] = []
	let note: string
	if (eligible.length === 0) {
		note =
			`no candidate met the declared goals across all six signals ` +
			`(memory ${budget.memoryBudget}B, candidate ${budget.maxCandidateWallMs}ms, ` +
			`throughput ${budget.minThroughputBytesPerSec}B/s, temp disk ${budget.maxTempDiskBytes}B) ` +
			`with margin ${budget.safetyMargin.toFixed(3)}x; no configuration emitted`
	} else {
		// Held-out validation on a DISJOINT row window: startRow=sampleRows so the
		// held-out sample is rows [sampleRows, 2*sampleRows) — not overlapping the
		// training window [0, sampleRows). A candidate that fails held-out is
		// REJECTED; try the next eligible. If none pass, no config.
		for (const cand of eligible) {
			const heldOutResults: CandidateResult[] = []
			for (const signal of ARCHIVE_SIGNALS) {
				if (Date.now() - matrixStart > budget.timeBudget) break
				// Held-out: a STRICTLY LARGER, disjoint window. Training covered
				// ordered rows [0, sampleRows); held-out covers
				// [sampleRows, sampleRows + heldOutRows) where heldOutRows is a
				// fixed multiple of the training size (plan-required larger sample).
				const result = await runCandidateChild(
					bundlePath,
					dataDir,
					checkpointId,
					checkpointManifestFingerprint,
					rangeDate,
					signal.name,
					scratchRoot,
					archiveDir,
					cand.candidate,
					budget,
					operationId,
					budget.sampleRows,
					heldOutSampleRows(budget.sampleRows),
					matrixStart,
				)
				heldOutResults.push(result)
			}
			// Require complete six-signal held-out evidence: every result within
			// ceilings AND observing exactly heldOutSampleRows rows (a larger
			// request is not a larger observed sample).
			const heldOutComplete =
				heldOutResults.length === requiredSignals.length &&
				heldOutResults.every(
					(r) =>
						meetsCeilings(r, budget) &&
						r.metrics?.rowCount === heldOutSampleRows(budget.sampleRows),
				)
			if (heldOutComplete) {
				const heldWorst = selectCandidates(
					new Map([[cand.candidate, heldOutResults]]),
					budget,
					requiredSignals,
				)[0]!.worstCase
				// PER-SIGNAL, like-for-like hybrid comparison: each signal's held-out
				// result is paired with the same candidate's TRAINING result for that
				// signal, and wallMs/physicalBytes are scaled by THAT signal's own
				// heldOut/training logical-byte ratio. Aggregate extrema never decide
				// acceptance; heldWorst is a descriptive summary only.
				const perSignal = compareHeldOutPerSignal(
					allResults,
					heldOutResults,
					requiredSignals,
					cand.candidate,
					HELD_OUT_TOLERANCES,
				)
				if (perSignal === null) {
					// Unpairable or non-positive logical bytes: treat as incomplete.
					heldOutAttempts.push({
						candidate: cand.candidate,
						results: heldOutResults,
						worstCase: null,
						signalComparisons: [],
						passed: false,
					})
					continue
				}
				heldOutAttempts.push({
					candidate: cand.candidate,
					results: heldOutResults,
					worstCase: heldWorst,
					signalComparisons: perSignal.signalComparisons,
					passed: perSignal.passed,
				})
				if (!perSignal.passed) continue
				selected = cand
				selectedHeldOut = {
					results: heldOutResults,
					worstCase: heldWorst,
					signalComparisons: perSignal.signalComparisons,
					passed: true,
					tolerances: HELD_OUT_TOLERANCES,
				}
				note =
					`selected the lowest-worst-case-peak-RSS candidate that met every ceiling ` +
					`on the disjoint held-out window across all six signals (per-signal comparison)`
				break
			}
			heldOutAttempts.push({
				candidate: cand.candidate,
				results: heldOutResults,
				worstCase: null,
				// Incomplete/over-budget/short-window attempt: no comparisons ran.
				signalComparisons: [],
				passed: false,
			})
		}
		if (selected === null) {
			note =
				`every eligible candidate failed held-out validation (disjoint window) ` +
				`or the data was insufficient for a complete six-signal held-out split; ` +
				`no configuration emitted`
		}
	}
	// Confidence "high" ⟺ selected !== null ⟺ a config is emitted. "low" means
	// small/unrepresentative data OR no disjoint held-out — always paired with
	// selected null and no config. Per-signal representative check (not a
	// cross-candidate sum that repetition could inflate): every signal's
	// training rowCount must reach at least the sampleRows target for the data
	// to be representative.
	const perSignalRepresentative = (() => {
		if (selected === null) return true // no false-high; selected null → low anyway
		const bySignal = new Map<string, number>()
		for (const r of allResults) {
			if (isSameCalibrationCandidate(r.candidate, selected.candidate) && r.ok && r.metrics) {
				bySignal.set(r.signal, Math.max(bySignal.get(r.signal) ?? 0, r.metrics.rowCount))
			}
		}
		return requiredSignals.every((s) => bySignal.get(s) === budget.sampleRows)
	})()
	const confidence: "high" | "low" = selected !== null && perSignalRepresentative ? "high" : "low"
	if (confidence === "low" && selected !== null) {
		// Downgrade to no-config: low confidence ⟺ selected null.
		note = `selected candidate's per-signal data is unrepresentative (below the ${budget.sampleRows}-row target); no configuration emitted`
		selected = null
		selectedHeldOut = null
	}
	return {
		formatVersion: TUNING_CONFIG_FORMAT_VERSION,
		checkpoint: { checkpointId, manifestFingerprint: checkpointManifestFingerprint },
		selected,
		heldOut: selectedHeldOut,
		heldOutAttempts,
		results: allResults,
		budget,
		environment,
		confidence,
		measuredAt: new Date().toISOString(),
		note: note!,
	}
}

/**
 * Internal calibration worker. The PARENT generates the operation id and passes
 * it via `--operation-id`, along with `--start-row` (for the disjoint held-out
 * window) and the operator's `--max-temp-disk` / `--free-space-reserve`. The
 * child reconciles any prior interrupted run INSIDE the maintenance lock,
 * records ownership derived from the operation id, restores a pinned checkpoint
 * into owned scratch, exports a deterministic EXACT window of rows through the
 * REAL shared writer, measures real metrics, and cleans up via the SAME
 * authoritative reconciler (no duplicate removal logic).
 */
const operationIdFlag = Flag.optional(
	Flag.string("operation-id").pipe(
		Flag.withDescription("Calibration operation id (parent-generated); derives owned paths"),
	),
)
const checkpointFingerprintFlag = Flag.optional(
	Flag.string("checkpoint-fingerprint").pipe(
		Flag.withDescription("Exact parent-session checkpoint manifest fingerprint"),
	),
)
const startRowFlag = Flag.integer("start-row").pipe(
	Flag.withDescription("Start row offset for the calibration window (0=training, sampleRows=held-out)"),
	Flag.withDefault(0),
)
const maxTempDiskCalibFlag = Flag.integer("max-temp-disk").pipe(
	Flag.withDescription("Maximum peak temporary disk in bytes (operator-supplied ceiling)"),
	Flag.withDefault(2 * 1024 * 1024 * 1024),
)
const freeSpaceReserveCalibFlag = Flag.integer("free-space-reserve").pipe(
	Flag.withDescription("Minimum free-space reserve on the archive volume in bytes"),
	Flag.withDefault(512 * 1024 * 1024),
)
// TEST SEAM (not for operator use): when set, the child writes a `paused` marker
// into the marker dir AFTER durable-writing the recovery record at the named
// phase, then blocks forever. The SIGKILL crash probe waits for the marker,
// asserts the durable state exists, then kills the process group. This makes the
// crash boundary deterministic and authoritative (C1).
const pauseAtPhaseFlag = Flag.optional(
	Flag.string("pause-at-phase").pipe(
		Flag.withDescription("TEST ONLY: pause (block) after durable-writing the record at this phase"),
	),
)
const markerDirFlag = Flag.optional(
	Flag.string("marker-dir").pipe(Flag.withDescription("TEST ONLY: directory for the pause marker file")),
)

export const archiveCalibrateRun = Command.make("calibrate-run", {
	signal: signalArgument,
	rangeDate: rangeDateArgument,
	dataDir: dataDirFlag,
	archiveDir: archiveDirFlag,
	scratchRoot: scratchRootFlag,
	checkpointId: checkpointIdFlag,
	checkpointFingerprint: checkpointFingerprintFlag,
	operationId: operationIdFlag,
	startRow: startRowFlag,
	sampleRows: sampleRowsFlag,
	maxTempDisk: maxTempDiskCalibFlag,
	freeSpaceReserve: freeSpaceReserveCalibFlag,
	writerThreads: writerThreadsFlag,
	rowGroupRows: rowGroupRowsFlag,
	maxShardRows: maxShardRowsFlag,
	maxShardBytes: maxShardBytesFlag,
	pauseAtPhase: pauseAtPhaseFlag,
	markerDir: markerDirFlag,
}).pipe(
	Command.withDescription(
		"Internal: export a calibration sample through the real writer and print metrics JSON",
	),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			if (!isArchiveSignalName(a.signal)) {
				return yield* new ArchiveError({ message: `unknown signal '${a.signal}'` })
			}
			let rangeDate: string
			try {
				rangeDate = validateRangeDate(a.rangeDate)
			} catch (error) {
				return yield* new ArchiveError({
					message: error instanceof Error ? error.message : String(error),
				})
			}
			const { dataDir, archiveDir, scratchRoot } = resolveRoots(a.dataDir, a.archiveDir, a.scratchRoot)
			const checkpointSelector = Option.getOrUndefined(a.checkpointId) ?? "current"
			yield* Effect.tryPromise({
				try: () =>
					runCalibrateSample(a, dataDir, archiveDir, scratchRoot, checkpointSelector, rangeDate),
				catch: (error) =>
					new ArchiveError({ message: error instanceof Error ? error.message : String(error) }),
			})
		}),
	),
)

/**
 * Open or close the parent calibration session that owns the single source
 * checkpoint pin and the durable recovery record. The matrix runner does this
 * inline; this command makes the lifecycle explicit so a single child sample
 * (or a SIGKILL probe) can run against an already-open session and so an
 * operator can inspect/retire a wedged session. `open` resolves the checkpoint,
 * reconciles any prior interrupted session, acquires the pin, and durably
 * records `pin-acquired`; it prints the operation id, checkpoint id, and
 * manifest fingerprint a child must bind to. `close` runs the authoritative
 * reconciler (releasing the pin and clearing the record).
 */
const sessionActionFlag = Flag.optional(
	Flag.string("action").pipe(
		Flag.withDescription("open: acquire the session pin + record; close: reconcile + release"),
	),
)
export const archiveCalibrateSession = Command.make("calibrate-session", {
	dataDir: dataDirFlag,
	archiveDir: archiveDirFlag,
	scratchRoot: scratchRootFlag,
	checkpointId: checkpointIdFlag,
	action: sessionActionFlag,
	pauseAtSessionPhase: pauseAtSessionPhaseFlag,
	sessionMarkerDir: sessionMarkerDirFlag,
}).pipe(
	Command.withDescription(
		"Internal: open or close the parent calibration session that owns the source pin",
	),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const { dataDir, archiveDir, scratchRoot } = resolveRoots(a.dataDir, a.archiveDir, a.scratchRoot)
			const action = Option.getOrUndefined(a.action) ?? "open"
			const checkpointSelector = Option.getOrUndefined(a.checkpointId) ?? "current"
			const roots = { dataDir, archiveDir, scratchRoot }
			if (action === "close") {
				yield* Effect.tryPromise({
					try: () =>
						withMaintenanceLock(dataDir, randomUUID(), () =>
							reconcileCalibration(archiveDir, roots),
						),
					catch: (error) =>
						new ArchiveError({ message: error instanceof Error ? error.message : String(error) }),
				})
				process.stdout.write(`${green("✓")} calibration session closed\n`)
				return
			}
			if (action !== "open") {
				return yield* new ArchiveError({ message: `unknown calibrate-session action '${action}'` })
			}
			const operationId = randomUUID()
			const pinId = randomUUID()
			const pinPurpose = calibrationPinPurpose(operationId)
			const scratchSubdir = derivedScratchSubdir(operationId)
			const sampleDir = derivedSampleDir(archiveDir, operationId)
			const result = yield* Effect.tryPromise({
				try: () =>
					withMaintenanceLock(dataDir, operationId, async () => {
						await reconcileCalibration(archiveDir, roots)
						const resolved = await resolveCheckpoint(
							dataDir,
							parseCheckpointSelector(checkpointSelector),
						)
						const manifestFingerprint = `${resolved.manifest.checkpointId}:${resolved.manifest.createdAt}:${resolved.manifest.backupBytes}`
						await writeCalibrationRecord(archiveDir, {
							phase: "intent",
							operationId,
							pinId,
							pinPurpose,
							pinPath: null,
							checkpointId: resolved.checkpointId,
							checkpointManifestFingerprint: manifestFingerprint,
							boundRoots: roots,
							ownedPaths: { scratchSubdir, sampleDir },
						})
						// TEST seam: a SIGKILL here leaves a durable intent record with
						// no pin, reproducing the intent-retention wedge.
						const pausePhase: string | undefined = Option.getOrUndefined(a.pauseAtSessionPhase)
						const markerDir: string | undefined = Option.getOrUndefined(a.sessionMarkerDir)
						if (pausePhase === "intent" && markerDir) {
							const { mkdirSync, writeFileSync } = await import("node:fs")
							mkdirSync(markerDir, { recursive: true })
							writeFileSync(
								join(markerDir, "paused"),
								`intent\n${process.pid}\n${new Date().toISOString()}\n`,
							)
							await new Promise<void>(() => {
								/* deterministic SIGKILL seam */
							})
						}
						const pinPath = await acquireCheckpointPin(
							dataDir,
							resolved.checkpointId,
							pinPurpose,
							pinId,
						)
						await writeCalibrationRecord(archiveDir, {
							phase: "pin-acquired",
							operationId,
							pinId,
							pinPurpose,
							pinPath,
							checkpointId: resolved.checkpointId,
							checkpointManifestFingerprint: manifestFingerprint,
							boundRoots: roots,
							ownedPaths: { scratchSubdir, sampleDir },
						})
						return { checkpointId: resolved.checkpointId, manifestFingerprint, pinPath }
					}),
				catch: (error) =>
					new ArchiveError({ message: error instanceof Error ? error.message : String(error) }),
			})
			// Machine-readable: a child binds to operation-id + checkpoint-id + fingerprint.
			process.stdout.write(
				`${JSON.stringify({
					operationId,
					checkpointId: result.checkpointId,
					manifestFingerprint: result.manifestFingerprint,
					pinPath: result.pinPath,
				})}\n`,
			)
		}),
	),
)

/**
 * Run one calibration sample (child process). Reconciles any prior interrupted
 * run INSIDE the maintenance lock (so a concurrent run cannot reconcile a live
 * run's resources), then records ownership DERIVED from the operation id,
 * restores a pinned checkpoint, exports a deterministic EXACT window of rows
 * through the REAL shared writer with the row-count assertion, measures real
 * metrics (export-section wall time, not process-launch-to-exit), and cleans up
 * via the SAME authoritative reconciler.
 */
const runCalibrateSample = async (
	a: {
		signal: string
		operationId: Option.Option<string>
		startRow: number
		sampleRows: number
		maxTempDisk: number
		freeSpaceReserve: number
		writerThreads: number
		rowGroupRows: number
		maxShardRows: number
		maxShardBytes: number
		pauseAtPhase: Option.Option<string>
		markerDir: Option.Option<string>
		checkpointFingerprint: Option.Option<string>
	},
	dataDir: string,
	archiveDir: string,
	scratchRoot: string,
	checkpointSelector: string,
	rangeDate: string,
): Promise<void> => {
	// The parent generates the operation id; derive the exact owned paths from it.
	const operationId = Option.getOrUndefined(a.operationId)
	const checkpointManifestFingerprint = Option.getOrUndefined(a.checkpointFingerprint)
	if (
		!operationId ||
		!checkpointManifestFingerprint ||
		checkpointSelector === "current" ||
		checkpointSelector === "previous"
	) {
		throw new Error(
			"calibrate-run requires a parent session operation id, exact checkpoint id, and checkpoint fingerprint",
		)
	}
	// TEST SEAM: if pauseAtPhase is set, write a marker and block after durable-
	// writing the record at that phase. The crash probe waits for the marker,
	// asserts the durable state, then SIGKILLs (C1).
	const pausePhase = Option.getOrUndefined(a.pauseAtPhase)
	const markerDir = Option.getOrUndefined(a.markerDir)
	const maybePause = async (phase: string): Promise<void> => {
		if (pausePhase !== phase || !markerDir) return
		const { writeFileSync } = await import("node:fs")
		const { join: joinPath } = await import("node:path")
		const { mkdirSync } = await import("node:fs")
		mkdirSync(markerDir, { recursive: true })
		writeFileSync(
			joinPath(markerDir, "paused"),
			`${phase}\n${process.pid}\n${new Date().toISOString()}\n`,
		)
		// Block forever until SIGKILL. A thrown error here would run the finally
		// (cleanup); a SIGKILL does not, leaving the durable state for reconcile.
		await new Promise<void>(() => {
			/* block forever */
		})
	}
	// The parent session owns the pin and the durable checkpoint identity; the
	// child only restores that pinned checkpoint into owned scratch and exports
	// a sample. See assertCalibrationSession / cleanupCalibrationSample.
	const scratchSubdir = derivedScratchSubdir(operationId)
	const sampleDir = derivedSampleDir(archiveDir, operationId)
	const settings: ExportSettings = {
		writerThreads: a.writerThreads,
		rowGroupRows: a.rowGroupRows,
		maxShardRows: a.maxShardRows,
		maxShardBytes: a.maxShardBytes,
	}
	// Free-space preflight with the OPERATOR-SUPPLIED reserve (not hardcoded).
	await preflightCalibrationFreeSpace(archiveDir, a.freeSpaceReserve, a.maxShardBytes * 4)
	const signal = archiveSignal(a.signal as Parameters<typeof archiveSignal>[0])
	// Captured during export; emitted to stdout ONLY after successful cleanup so
	// a cleanup failure causes a nonzero exit and the parent marks this candidate
	// failed (C5: a run that left a pin/record/debris must not be selected).
	let pendingMetrics: ChildMetrics | null = null
	// The maintenance lock serializes calibration against create/GC. Reconcile
	// any prior interrupted run INSIDE the lock, matching generation.ts:246-283.
	await withMaintenanceLock(dataDir, operationId, async () => {
		const session = await assertCalibrationSession(
			archiveDir,
			{ dataDir, archiveDir, scratchRoot },
			{
				operationId,
				checkpointId: checkpointSelector,
				checkpointManifestFingerprint,
			},
		)
		await cleanupCalibrationSample(session)
		const resolved = await resolveCheckpoint(dataDir, parseCheckpointSelector(checkpointSelector))
		const liveFingerprint = `${resolved.manifest.checkpointId}:${resolved.manifest.createdAt}:${resolved.manifest.backupBytes}`
		if (liveFingerprint !== checkpointManifestFingerprint) {
			throw new Error("calibration child checkpoint fingerprint changed; refusing")
		}
		await maybePause("pin-acquired")
		try {
			await withRestoredCheckpoint(
				resolved,
				{
					scratchRoot,
					scratchSubdir,
					cleanup: "never",
					beforeRestore: async () => {
						await maybePause("scratch-allocated")
					},
				},
				async ({ db }) => {
					await ensurePrivateDirectory(sampleDir, archiveDir)
					// The sampling seam is intentionally after both the durable phase
					// record and the owned sample directory exist. Together with the
					// restored scratch allocated by withRestoredCheckpoint, this lets
					// the SIGKILL probe exercise cleanup of every owned resource.
					await maybePause("sampling")
					db.exec(`SYSTEM STOP MERGES ${signal.name}`)
					const exportStart = Date.now()
					try {
						const sourceSchema = captureSourceSchema(db, signal)
						// EXACT window: plan returns { plansByHour, totalRows } where
						// totalRows is the exact matching-row count for this window.
						const { plansByHour, totalRows } = planCalibrationShards(
							db,
							signal,
							rangeDate,
							settings,
							a.sampleRows,
							a.startRow,
						)
						// The writer asserts Σ rowCount === totalRows (exact bound).
						const shards = exportShardPlans(
							db,
							signal,
							rangeDate,
							sampleDir,
							settings,
							sourceSchema,
							plansByHour,
							totalRows,
						)
						const exportWallMs = Date.now() - exportStart
						let logicalBytes = 0
						let physicalBytes = 0
						let rowCount = 0
						for (const shard of shards) {
							const measured = measureShardBytes(db, shard.path)
							logicalBytes += measured.uncompressed
							physicalBytes += shard.bytes
							rowCount += shard.rowCount
						}
						const peakTempDiskBytes =
							(await directoryTreeBytes(resolve(scratchRoot, scratchSubdir))) +
							(await directoryTreeBytes(sampleDir))
						// Capture the metrics but DO NOT emit them yet — emit only after
						// successful cleanup so a cleanup failure causes a nonzero exit and
						// the parent marks the candidate failed (C5).
						pendingMetrics = {
							logicalBytes,
							physicalBytes,
							peakTempDiskBytes,
							peakRssBytes: process.memoryUsage().rss,
							exportWallMs,
							rowCount,
							// The child is the authoritative source of its exact sample scope:
							// it ran planCalibrationShards(startRow, sampleRows) against this
							// exact checkpoint/range and the writer asserted rowCount === totalRows.
							sample: {
								checkpointId: checkpointSelector,
								checkpointManifestFingerprint,
								rangeDate,
								role: a.startRow === 0 ? "training" : "held-out",
								startRow: a.startRow,
								requestedRows: a.sampleRows,
								rowCount,
							},
						}
					} finally {
						db.exec(`SYSTEM START MERGES ${signal.name}`)
					}
				},
			)
		} finally {
			// Normal cleanup calls the SAME authoritative reconciler (no duplicate
			// removal logic). A cleanup-reconciliation FAILURE must propagate as a
			// nonzero exit (NOT suppressed), so the parent marks the candidate
			// failed and does not select a run that left a pin/record/debris. The
			// record is PRESERVED for the next run by the reconciler itself.
			await cleanupCalibrationSample(session)
			// Emit the metrics JSON ONLY after successful cleanup.
			if (pendingMetrics) {
				process.stdout.write(`${JSON.stringify(pendingMetrics)}\n`)
			}
		}
	})
}

export const archive = Command.make("archive").pipe(
	Command.withDescription("Manage local Parquet telemetry archives exported from immutable checkpoints"),
	Command.withSubcommands([
		archiveCreate,
		archiveList,
		archiveVerify,
		archiveRebuild,
		archiveReconcile,
		archiveGc,
		archiveCalibrate,
		archiveCalibrateRun,
		archiveCalibrateSession,
	]),
)
