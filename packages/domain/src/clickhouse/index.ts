export {
	emitCreateMaterializedView,
	emitCreateTable,
	emitJsonPathSpec,
	emitProjectDdl,
	extractColumnDefinition,
	parseEmittedStatement,
	type EmittedMaterializedView,
	type EmittedStatement,
	type EmittedTable,
	type EmittedTableColumn,
	type EmitterOptions,
	type EngineFlavor,
	type ResourceContent,
} from "./ddl-emitter"
export {
	migrations,
	latestMigrationVersion,
	clickHouseSchemaVersion,
	type ClickHouseMigration,
	type MigrationStatement,
} from "./migrations"
export { performanceOnlySearchColumns } from "./migrations/0010_search_indexes"
export { AI_CLASSIFICATION_ALTER_STATEMENTS } from "./migrations/0016_ai_classification_columns"
export {
	type BackfillSpec,
	isBackfill,
	SOURCE_TIME_COLUMNS,
	renderBackfillFull,
	renderStatementFull,
	compileBackfillChunk,
} from "./backfill"
export { expandMigrationToSteps, expandBackfill, type ApplyStep, type ExecFn } from "./apply-plan"
export { qualifyStatementForDatabase, CLICKHOUSE_MV_SOURCE_TABLES } from "./qualify"
export {
	computeSchemaDiff,
	type ColumnDrift,
	type DesiredSchema,
	type DesiredTable,
	type ActualTable,
	type TableDiffEntry,
} from "./diff"
export { projectRevision as clickHouseProjectRevision } from "../generated/clickhouse-schema"
export {
	clickHouseSchemaFeatures,
	clickHouseVersionAtLeast,
	featureSupportedByVersion,
	ClickHouseSchemaFeatureId,
	type ClickHouseSchemaFeature,
} from "./features"
