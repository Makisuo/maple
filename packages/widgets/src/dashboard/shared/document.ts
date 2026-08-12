import { Schema } from "effect"
import { DashboardId, IsoDateTimeString, PostgresTransactionId } from "@maple/primitives"
import { DashboardSectionsSchema } from "./sections"
import { TimeRangeSchema } from "./time-range"
import { DashboardRefreshIntervalSeconds, DashboardVariableSchema } from "./variables"
import { DashboardSchemaVersion } from "../version"

/**
 * Field records for a schema version's two document shapes, parameterised on the
 * widget. Returns *fields* rather than built classes: `Schema.Class` needs a
 * `Self` type parameter it can't get inside a generic factory, and each version
 * declaring its own class keeps the identifier strings (which surface in decode
 * errors and OpenAPI component names) visible at the declaration site.
 */
export const makeDashboardDocumentFields = <Widget extends Schema.Top>(options: {
	readonly widget: Widget
}) => {
	const portable = {
		// Optional in, always out: the persistence layer stamps it on every write,
		// but every document written before it existed has no key, and the IaC
		// provider, the MCP tools, the templates and the Perses importer all
		// construct documents literally without one. Absent means version 1 — see
		// `detectSchemaVersion`.
		schemaVersion: Schema.optionalKey(DashboardSchemaVersion),
		name: Schema.String,
		description: Schema.optionalKey(Schema.String),
		tags: Schema.optionalKey(Schema.Array(Schema.String)),
		timeRange: TimeRangeSchema,
		widgets: Schema.Array(options.widget),
		sections: Schema.optionalKey(DashboardSectionsSchema),
		variables: Schema.optionalKey(Schema.Array(DashboardVariableSchema)),
		refreshIntervalSeconds: Schema.optionalKey(DashboardRefreshIntervalSeconds),
	} as const

	const document = {
		id: DashboardId,
		...portable,
		createdAt: IsoDateTimeString,
		updatedAt: IsoDateTimeString,
		// Postgres transaction id of the write that produced this response, present
		// only on mutation responses (create/upsert/restore/import). The web's
		// ElectricSQL collection write handlers pass it to `awaitTxId` to resolve
		// optimistic state on the exact synced transaction. Never persisted into
		// `payload_json` (stripped at the storage boundary) and never present on
		// list/read responses.
		txid: Schema.optionalKey(PostgresTransactionId),
	} as const

	return { portable, document } as const
}
