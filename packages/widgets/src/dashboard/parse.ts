import { Effect, Schema, SchemaIssue } from "effect"
import { detectSchemaVersion, migrateToLatest } from "./migrations"
import { DashboardDocumentV1 } from "./v1/document"
import { CURRENT_DASHBOARD_SCHEMA_VERSION, type DashboardSchemaVersion } from "./version"

/**
 * The result of reading a stored dashboard payload.
 *
 * `Rejected` is a value rather than an error channel: how a caller reacts
 * depends on where the document came from, and only the caller knows that. The
 * writable path must refuse a document it cannot fully decode — a read that
 * silently drops fields would be persisted by the next read-modify-write and
 * destroy the original — while the read-only version-history path is better off
 * showing a degraded preview than a 503.
 */
export type DashboardParseOutcome =
	| {
			readonly _tag: "Decoded"
			readonly document: DashboardDocumentV1
			/** The version the payload was stored in, before migration. */
			readonly fromVersion: DashboardSchemaVersion
			/**
			 * Widgets that decoded only via a permissive fallback. Structurally always
			 * empty until the closed per-endpoint params union lands; the field and
			 * its span annotation exist from the start so the metric has history by
			 * the time it decides whether the fallback can be removed.
			 */
			readonly degradedWidgetIds: ReadonlyArray<string>
	  }
	| {
			readonly _tag: "Rejected"
			readonly fromVersion: DashboardSchemaVersion
			readonly issue: string
	  }

const decodeDocument = Schema.decodeUnknownEffect(DashboardDocumentV1)
/** Path-anchored, newline-joined rendering of the issue tree. */
const formatIssue = SchemaIssue.makeFormatterDefault()

/**
 * Migrates a stored payload up to the current schema version, then decodes it.
 * Never fails: every outcome is expressed in the returned value.
 */
export const parseStoredDashboard = (
	payload: unknown,
): Effect.Effect<DashboardParseOutcome, never, never> => {
	const fromVersion = detectSchemaVersion(payload)

	return decodeDocument(migrateToLatest(payload)).pipe(
		Effect.map(
			(document): DashboardParseOutcome => ({
				_tag: "Decoded",
				document,
				fromVersion,
				degradedWidgetIds: [],
			}),
		),
		Effect.catchTag(
			"SchemaError",
			(error): Effect.Effect<DashboardParseOutcome> =>
				Effect.succeed({
					_tag: "Rejected",
					fromVersion,
					issue: formatIssue(error.issue),
				}),
		),
	)
}

/**
 * Stamps a document with the current schema version. Applied at the single write
 * choke point so every writer — v1 upsert, v2 PATCH, MCP, template instantiate,
 * Perses import, version restore — records the shape it wrote.
 */
export const stampCurrentVersion = <Document extends object>(
	document: Document,
): Document & { readonly schemaVersion: DashboardSchemaVersion } => ({
	...document,
	schemaVersion: CURRENT_DASHBOARD_SCHEMA_VERSION,
})
