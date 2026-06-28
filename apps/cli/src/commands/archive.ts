import { Effect, Option, Schema } from "effect"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import * as Argument from "effect/unstable/cli/Argument"
import { homedir } from "node:os"
import { join } from "node:path"
import { createArchiveGeneration } from "../server/archives/generation"
import { listActiveGenerations, activeParquetPaths, rebuildCatalog } from "../server/archives/listing"
import { resolveArchiveTuning, type ArchiveTuningOverrides } from "../server/archives/config"
import { ARCHIVE_SIGNALS, isArchiveSignalName } from "../server/archives/signals"
import { validateRangeDate } from "../server/archives/paths"
import { amber, bold, dim, green } from "../lib/style"

/** An archive command failure. The message is shown to the user and the process
 *  exits non-zero, mirroring `ServerError` and `CheckpointError`. */
class ArchiveError extends Schema.TaggedErrorClass<ArchiveError>()("@maple/cli/ArchiveError", {
	message: Schema.String,
}) {}

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
const tuningOverrides = (dataDir: string, archiveDir: string, scratchRoot: string): ArchiveTuningOverrides =>
	({ archiveDir, scratchRoot, dataDir }) as ArchiveTuningOverrides

/** Resolve the archive and scratch roots from flags, falling back to defaults. */
const resolveRoots = (
	dataDirOpt: Option.Option<string>,
	archiveDirOpt: Option.Option<string>,
	scratchRootOpt: Option.Option<string>,
): { dataDir: string; archiveDir: string; scratchRoot: string } => ({
	dataDir: Option.getOrUndefined(dataDirOpt) ?? defaultDataDir(),
	archiveDir: Option.getOrUndefined(archiveDirOpt) ?? defaultArchiveDir(),
	scratchRoot: Option.getOrUndefined(scratchRootOpt) ?? defaultScratchRoot(),
})

export const archiveCreate = Command.make("create", {
	dataDir: dataDirFlag,
	archiveDir: archiveDirFlag,
	scratchRoot: scratchRootFlag,
	checkpointId: checkpointIdFlag,
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
			let tuning
			try {
				tuning = resolveArchiveTuning(tuningOverrides(dataDir, archiveDir, scratchRoot))
			} catch (error) {
				return yield* new ArchiveError({
					message: error instanceof Error ? error.message : String(error),
				})
			}
			yield* Effect.sync(() =>
				process.stderr.write(
					`${amber("⟳")} archiving ${bold(a.signal)} for ${bold(rangeDate)} ` +
						`from ${prettyPath(dataDir)}\n`,
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
	Command.withDescription("List active archive generations and their Parquet shard paths"),
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
				const paths = activeParquetPaths(archiveDir, signalOpt)
				yield* Effect.sync(() => process.stdout.write(`${paths.map((p) => `"${p}"`).join(",")}\n`))
				return
			}
			const listing = listActiveGenerations(archiveDir)
			if (a.output === "json") {
				yield* Effect.sync(() => process.stdout.write(`${JSON.stringify(listing, null, 2)}\n`))
				return
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
					`${green("✓")} ${listing.active.length} active generation(s) in ${prettyPath(archiveDir)}\n${lines.join("\n")}\n`,
				),
			)
		}),
	),
)

export const archiveRebuild = Command.make("rebuild", {
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
			const archiveDir = Option.getOrUndefined(a.archiveDir) ?? defaultArchiveDir()
			const entries = rebuildCatalog(archiveDir, a.signal)
			yield* Effect.sync(() =>
				process.stdout.write(
					`${green("✓")} rebuilt ${a.signal} catalog with ${entries.length} generation(s)\n`,
				),
			)
		}),
	),
)

export const archive = Command.make("archive").pipe(
	Command.withDescription("Manage local Parquet telemetry archives exported from immutable checkpoints"),
	Command.withSubcommands([archiveCreate, archiveList, archiveRebuild]),
)
