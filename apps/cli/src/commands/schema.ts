import { Effect, Option, Schema } from "effect"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { homedir } from "node:os"
import { join } from "node:path"
import { bold, dim, green, amber } from "../lib/style"
import {
	formatMigrationPlan,
	identityFromMarker,
	abandonLocalStoreMigrationPreservingSource,
	migrationStatus,
	planMigration,
	runLocalStoreMigration,
	type MigrationPlan,
} from "../server/local-store-migrations"
import { maintenanceOperation } from "../server/checkpoints"
import { readMarker } from "../server/store-version"

class SchemaCommandError extends Schema.TaggedError<SchemaCommandError>()("@maple/cli/SchemaCommandError", {
	message: Schema.String,
}) {}

const defaultDataDir = (): string => join(homedir(), ".maple", "data")

const dataDirFlag = Flag.optional(
	Flag.string("data-dir").pipe(
		Flag.withDescription("Embedded ClickHouse data directory (default: ~/.maple/data)"),
	),
)

const yesFlag = Flag.boolean("yes").pipe(
	Flag.withAlias("y"),
	Flag.withDescription("Confirm the migration and its stated preservation envelope"),
	Flag.withDefault(false),
)

const abandonYesFlag = Flag.boolean("yes").pipe(
	Flag.withAlias("y"),
	Flag.withDescription("Confirm quarantining the staged target while preserving the active source"),
	Flag.withDefault(false),
)

const dryRunFlag = Flag.boolean("dry-run").pipe(
	Flag.withDescription("Print the migration plan without creating a target or changing the source"),
	Flag.withDefault(false),
)

const resolvedDataDir = (value: Option.Option<string>): string =>
	Option.getOrUndefined(value) ?? defaultDataDir()

const markerIdentity = (dataDir: string) => {
	const marker = readMarker(dataDir)
	if (!marker) throw new Error("no readable local-store marker was found")
	const identity = identityFromMarker(marker)
	if (!identity) throw new Error(`the store fingerprint ${marker.schema || "<none>"} is not registered`)
	return { marker, identity }
}

export const schemaStatus = Command.make("status", { dataDir: dataDirFlag }).pipe(
	Command.withDescription("Show local-store schema identity and migration journal state"),
	Command.withHandler(
		Effect.fnUntraced(function* (args) {
			const dataDir = resolvedDataDir(args.dataDir)
			const status = yield* Effect.tryPromise({
				try: () => migrationStatus(dataDir),
				catch: (error) =>
					new SchemaCommandError({
						message: error instanceof Error ? error.message : String(error),
					}),
			})
			if (status.marker === null) {
				yield* Effect.sync(() => process.stdout.write(`${dim("no local-store marker")}\n`))
				return
			}
			const marker = status.marker
			const lines = [
				`data: ${dataDir}`,
				`marker format: ${marker.formatVersion}`,
				`chDB: ${marker.chdb}`,
				`schema fingerprint: ${marker.schema || "<none>"}`,
				...(marker.formatVersion === 2
					? [
							`schema version: ${marker.schemaVersion}`,
							`schema digest: ${marker.schemaDigest}`,
							`store id: ${marker.storeId}`,
							`activation: ${marker.activation}`,
							`created: ${marker.createdAt} by ${marker.createdByMaple}`,
						]
					: [`created: ${marker.createdAt} by ${marker.maple}`]),
				`migration journal: ${status.journal?.phase ?? "none"}`,
				`physical check: ${status.physicalCheck}`,
			]
			yield* Effect.sync(() => process.stdout.write(`${lines.join("\n")}\n`))
		}),
	),
)

export const schemaPlan = Command.make("plan", { dataDir: dataDirFlag }).pipe(
	Command.withDescription("Show the deterministic local-store migration plan"),
	Command.withHandler(
		Effect.fnUntraced(function* (args) {
			const dataDir = resolvedDataDir(args.dataDir)
			const { identity } = yield* Effect.try({
				try: () => markerIdentity(dataDir),
				catch: (error) =>
					new SchemaCommandError({
						message: error instanceof Error ? error.message : String(error),
					}),
			})
			const plan = yield* Effect.try({
				try: () => planMigration(identity),
				catch: (error) =>
					new SchemaCommandError({
						message: error instanceof Error ? error.message : String(error),
					}),
			})
			yield* Effect.sync(() => process.stdout.write(formatMigrationPlan(plan)))
		}),
	),
)

const planSummary = (plan: MigrationPlan): string =>
	`${plan.chain.map((migration) => migration.id).join(" -> ")}\n` +
	`This migration requires a stopped source and retains the original store as a pre-cutover rollback point.\n` +
	`Existing checkpoints remain with that source and are not restorable by the current schema.\n`

export const schemaMigrate = Command.make("migrate", {
	dataDir: dataDirFlag,
	yes: yesFlag,
	dryRun: dryRunFlag,
}).pipe(
	Command.withDescription("Migrate a supported populated local store into a staged current-schema store"),
	Command.withHandler(
		Effect.fnUntraced(function* (args) {
			const dataDir = resolvedDataDir(args.dataDir)
			const preview = yield* maintenanceOperation({
				operation: "schema.migrate_preview",
				try: () => runLocalStoreMigration({ dataDir, dryRun: true }),
				catch: (error) =>
					new SchemaCommandError({
						message: error instanceof Error ? error.message : String(error),
					}),
			})
			if (preview instanceof Object && "chain" in preview) {
				const plan = preview as MigrationPlan
				if (args.dryRun) {
					yield* Effect.sync(() => process.stdout.write(formatMigrationPlan(plan)))
					return
				}
				if (!args.yes) {
					yield* Effect.sync(() =>
						process.stderr.write(
							`${amber("Migration not started.")}\n${planSummary(plan)}Re-run with ${bold("maple schema migrate --yes")} to confirm.\n`,
						),
					)
					return
				}
			}
			const result = yield* maintenanceOperation({
				operation: "schema.migrate_apply",
				try: () =>
					runLocalStoreMigration({
						dataDir,
						onProgress: (message) => process.stderr.write(`${dim("·")} ${message}\n`),
					}),
				catch: (error) =>
					new SchemaCommandError({
						message: error instanceof Error ? error.message : String(error),
					}),
			})
			if ("migrationId" in result) {
				yield* Effect.sync(() =>
					process.stdout.write(
						`${green("✓")} local store migrated\n` +
							`  ${dim("migration")} ${result.migrationId}\n` +
							`  ${dim("cutoff")}   ${result.cutoffAt}\n` +
							`  ${dim("rollback")} ${result.sourceRollbackDir}\n` +
							`  ${dim("active")}   ${result.targetDataDir}\n` +
							`  ${dim("guarantee")} raw telemetry exact within each table's retention horizon; older aggregate-only history remains with the retained legacy source\n` +
							`  ${dim("next")}     create a new checkpoint before resuming long-lived retention\n`,
					),
				)
			}
		}),
	),
)

export const schemaAbandon = Command.make("abandon", {
	dataDir: dataDirFlag,
	yes: abandonYesFlag,
}).pipe(
	Command.withDescription("Quarantine an unfinished staged target while preserving the active source"),
	Command.withHandler(
		Effect.fnUntraced(function* (args) {
			const dataDir = resolvedDataDir(args.dataDir)
			if (!args.yes) {
				yield* Effect.sync(() =>
					process.stderr.write(
						`${amber("Target not abandoned.")} This moves only the journal-owned staged target into a recoverable quarantine and preserves the active source, checkpoints, and rollback data. Re-run with ${bold("maple schema abandon --yes")} to confirm.\n`,
					),
				)
				return
			}
			const quarantine = yield* maintenanceOperation({
				operation: "schema.abandon",
				try: () => abandonLocalStoreMigrationPreservingSource(dataDir),
				catch: (error) =>
					new SchemaCommandError({
						message: error instanceof Error ? error.message : String(error),
					}),
			})
			yield* Effect.sync(() =>
				process.stdout.write(
					quarantine === null
						? `${dim("No unfinished staged migration was found.")}\n`
						: `${green("✓")} staged target quarantined\n  ${dim("quarantine")} ${quarantine}\n  ${dim("source")}    ${dataDir}\n`,
				),
			)
		}),
	),
)

export const schema = Command.make("schema").pipe(
	Command.withDescription("Inspect and migrate the local chDB schema"),
	Command.withSubcommands([schemaStatus, schemaPlan, schemaMigrate, schemaAbandon]),
)
