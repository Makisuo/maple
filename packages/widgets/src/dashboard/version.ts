import { Schema } from "effect"

/**
 * The schema version a stored dashboard document is written in.
 *
 * This is NOT `dashboards.version` in Postgres — that column is the
 * compare-and-swap counter for optimistic concurrency, and it changes on every
 * write. This says what *shape* the JSON is in.
 *
 * A document with no `schemaVersion` key is version 1 by definition: the field
 * was introduced after those documents were written, so absence is the only
 * signal they can carry. `detectSchemaVersion` encodes that.
 */
export const DashboardSchemaVersion = Schema.Literals([1, 2]).annotate({
	identifier: "@maple/DashboardSchemaVersion",
	title: "Dashboard Schema Version",
})
export type DashboardSchemaVersion = typeof DashboardSchemaVersion.Type

export const CURRENT_DASHBOARD_SCHEMA_VERSION = 2 satisfies DashboardSchemaVersion
