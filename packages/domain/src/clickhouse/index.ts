export {
	emitCreateMaterializedView,
	emitCreateTable,
	emitJsonPathSpec,
	emitProjectDdl,
	parseEmittedStatement,
	type EmittedMaterializedView,
	type EmittedStatement,
	type EmittedTable,
	type EmittedTableColumn,
	type EmitterOptions,
	type EngineFlavor,
	type ResourceContent,
} from "./ddl-emitter"
export { migrations, type ClickHouseMigration } from "./migrations"
export {
	computeSchemaDiff,
	type ColumnDrift,
	type DesiredSchema,
	type DesiredTable,
	type ActualTable,
	type TableDiffEntry,
} from "./diff"
export { projectRevision as clickHouseProjectRevision } from "../generated/clickhouse-schema"
