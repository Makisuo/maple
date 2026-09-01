// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
import type { QuerySet } from "@maple/query-model"
import { MARKDOWN_STATIC_ENDPOINT, QUERY_ENDPOINT_RESULT_KINDS, RAW_SQL_ENDPOINT } from "./legacy-endpoints"
import { migrateToLatest } from "./migrations"
import { CURRENT_DASHBOARD_SCHEMA_VERSION } from "./version"
import type { WidgetDataSourceTransformV2 } from "./shared/transform"
import type { WidgetDataSourceV3 } from "./v3/data-source"

/**
 * The one-shot upgrade of a stored dashboard document from the v2
 * `{ endpoint, params }` data-source bag to the v3 discriminated union.
 *
 * Deliberately NOT a `DashboardMigration` and not part of `DASHBOARD_MIGRATIONS`.
 * The chain exists to migrate documents lazily, in memory, on every read, for as
 * long as a row goes unwritten — the right design when two shapes must coexist
 * indefinitely. They do not here: this runs ONCE against Postgres via the
 * backfill script, and after it every stored row is v3. Registering it as a chain
 * step would mean carrying a permanent read-path branch to serve rows that no
 * longer exist.
 *
 * There is no inverse. An encoder back to `{ endpoint, params }` existed while the
 * public `/v2` API was going to keep the legacy wire shape; that API now emits v3
 * too, so nothing needs the downgrade and it is gone rather than kept "just in
 * case".
 *
 * Total and idempotent, because a backfill must be safe to re-run: a document it
 * does not understand comes back unchanged rather than throwing, and a document
 * already in v3 is returned as-is. Both properties are what let the script be
 * killed halfway and started again.
 */

type V3DataSource = typeof WidgetDataSourceV3.Type
type Transform = typeof WidgetDataSourceTransformV2.Type

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

/** Spread-if-present, so an absent `optionalKey` never becomes a present `undefined`. */
const put = <K extends string, V>(key: K, value: V | undefined): Record<string, never> | { [P in K]: V } => {
	if (value === undefined) return {}
	// SAFETY: the computed property is created from the same generic key and value returned by this helper.
	return { [key]: value } as { [P in K]: V }
}

/**
 * TOTAL and never throws — this runs inside the backfill, which must be safe to
 * re-run and must never fail on a stored document however malformed. Everything
 * is read defensively and anything unrecognised falls through to a `route`, the
 * arm that preserves an arbitrary endpoint plus an opaque bag verbatim. The worst case is therefore "stored unchanged in
 * a different envelope", never "data dropped".
 */
export const fromLegacyDataSource = (dataSource: unknown): V3DataSource => {
	if (!isRecord(dataSource)) return { kind: "static" }

	const transform = isRecord(dataSource.transform)
		? put("transform", dataSource.transform as Transform)
		: {}
	const endpoint = typeof dataSource.endpoint === "string" ? dataSource.endpoint : null
	const params = isRecord(dataSource.params) ? dataSource.params : {}

	if (endpoint === null) {
		// Already v3? Return it as-is so the migration is idempotent. This is the
		// same structural test the backfill uses to decide a row is done.
		if (typeof dataSource.kind === "string") return dataSource as V3DataSource
		return { kind: "static", ...transform }
	}

	if (endpoint === MARKDOWN_STATIC_ENDPOINT) return { kind: "static", ...transform }

	if (endpoint === RAW_SQL_ENDPOINT) {
		return {
			kind: "raw_sql",
			// The v2 accessor coerced a missing `sql` to "" and callers relied on it;
			// v3 makes the field required, so the coercion happens here instead —
			// once, at the boundary, rather than on every read.
			sql: typeof params.sql === "string" ? params.sql : "",
			...put("displayType", typeof params.displayType === "string" ? params.displayType : undefined),
			...put(
				"granularitySeconds",
				typeof params.granularitySeconds === "number" ? params.granularitySeconds : undefined,
			),
			...transform,
		}
	}

	const resultKind = QUERY_ENDPOINT_RESULT_KINDS[endpoint]
	if (resultKind !== undefined) {
		return {
			kind: "query",
			resultShape: resultKind,
			queries: Array.isArray(params.queries)
				? (params.queries.map(repairQueryDraft) as QuerySet["queries"])
				: [],
			...put(
				"formulas",
				Array.isArray(params.formulas) ? (params.formulas as QuerySet["formulas"]) : undefined,
			),
			...put(
				"comparison",
				isRecord(params.comparison) ? (params.comparison as QuerySet["comparison"]) : undefined,
			),
			...put("defaultLimit", typeof params.defaultLimit === "number" ? params.defaultLimit : undefined),
			...put("limit", typeof params.limit === "number" ? params.limit : undefined),
			...put(
				"columns",
				Array.isArray(params.columns) ? (params.columns as ReadonlyArray<string>) : undefined,
			),
			...transform,
		}
	}

	return {
		kind: "route",
		endpoint,
		...put("params", isRecord(dataSource.params) ? dataSource.params : undefined),
		...transform,
	}
}

/**
 * Repairs the one v2-era looseness that stops a stored draft decoding.
 *
 * `queries` lived inside the untyped `params` bag, so nothing ever validated the
 * drafts inside it and the UI wrote `limit` as a number on some paths while the
 * schema declares `string | undefined`. v3 hoists `queries` to a typed field, so
 * those rows stop decoding — and a rejected document is refused by the writable
 * path, which locks the entire dashboard out of editing over one widget.
 *
 * Coerce rather than reject, exactly as `v1ToV2` does for the three fields v2
 * closed: `String(50)` is the value the builder round-trips to anyway, so a
 * repaired draft behaves identically to how it rendered before.
 *
 * Deliberately narrow. This is not a general-purpose draft repair — it fixes the
 * single field that the production dry run proved is stored off-type, and any
 * other malformation still quarantines loudly rather than being papered over.
 */
const repairQueryDraft = (draft: unknown): unknown => {
	if (!isRecord(draft) || typeof draft.limit !== "number") return draft
	return { ...draft, limit: String(draft.limit) }
}

/**
 * Already v3 iff it carries a string `kind`.
 *
 * Structural rather than a flag or a version column, so re-running is inherently
 * a no-op and no cursor state can cause a double transform. The backfill uses the
 * same test to decide a row is done.
 */
export const isV3DataSource = (dataSource: unknown): boolean =>
	isRecord(dataSource) && typeof dataSource.kind === "string"

const upgradeDataSource = (dataSource: unknown): unknown =>
	isV3DataSource(dataSource) ? dataSource : fromLegacyDataSource(dataSource)

/**
 * `display.sparkline.dataSource` embeds a FULL data source, so it needs the same
 * treatment as the widget's own.
 *
 * Easy to miss: `v1ToV2` never had to recurse, so there is no precedent in this
 * package to copy. A sparkline left in v2 shape decodes as a `route` whose
 * endpoint is `custom_query_builder_timeseries`, which renders an empty sparkline
 * rather than failing loudly — a silent bug that would survive any test checking
 * only the widget's top-level data source.
 */
const upgradeDisplay = (display: unknown): unknown => {
	if (!isRecord(display)) return display
	const sparkline = display.sparkline
	if (!isRecord(sparkline) || sparkline.dataSource === undefined) return display
	return {
		...display,
		sparkline: { ...sparkline, dataSource: upgradeDataSource(sparkline.dataSource) },
	}
}

const upgradeWidget = (widget: unknown): unknown => {
	if (!isRecord(widget)) return widget

	const next: Record<string, unknown> = { ...widget } satisfies Record<string, unknown>
	if (widget.dataSource !== undefined) next.dataSource = upgradeDataSource(widget.dataSource)
	if (widget.display !== undefined) next.display = upgradeDisplay(widget.display)
	return next
}

export const upgradeDocumentToV3 = (document: unknown): unknown => {
	if (!isRecord(document)) return document
	if (!Array.isArray(document.widgets)) return document
	return { ...document, widgets: document.widgets.map(upgradeWidget) }
}

/**
 * The complete stored-payload upgrade: whatever version a row is in, to v3.
 *
 * THE function the backfill script calls, and the reason it exists rather than
 * the script calling `upgradeDocumentToV3` directly: a v1 row needs more than a
 * data-source rewrite. v1 stored `visualization`, `reduceToValue.aggregate` and
 * `sortBy.direction` as open strings, and only `v1ToV2` coerces them into the
 * closed sets v2 and v3 both require. Skipping it would convert the data source
 * correctly and still leave the document undecodable, quarantining every
 * pre-versioning dashboard for a reason that has nothing to do with v3.
 *
 * `migrateToLatest` walks the chain as far as it reaches (2, since the v2 -> v3
 * step is deliberately not a chain entry), then this applies the one-shot on top.
 * Once the backfill has run and `migrations/` is deleted, this collapses to
 * `upgradeDocumentToV3` — and by then nothing calls it.
 */
export const upgradeStoredDocument = (payload: unknown): unknown => {
	// A document declaring a NEWER version than this build knows comes back from
	// `migrateToLatest` untouched — but the v3 rewrite and the unconditional
	// restamp below would then erase its version marker and mangle any data
	// source shape v3 cannot know. Pass it through unchanged instead.
	if (isRecord(payload)) {
		const declared = payload.schemaVersion
		if (typeof declared === "number" && declared > CURRENT_DASHBOARD_SCHEMA_VERSION) return payload
	}
	const upgraded = upgradeDocumentToV3(migrateToLatest(payload))
	// Restamp here, not in `migrateToLatest`. That function stamps the version it
	// actually REACHED — which is 2, since the chain stops there — and it is right
	// to, because on its own it has not produced a v3 document. Only after the
	// one-shot has run is the stamp true, so only here can it be written.
	return isRecord(upgraded) ? { ...upgraded, schemaVersion: CURRENT_DASHBOARD_SCHEMA_VERSION } : upgraded
}

/**
 * True when every data source in the document — widget-level and sparkline — is
 * already v3.
 *
 * The backfill's "is this row done?" predicate and the verification query's
 * in-process equivalent. Kept beside the transform so the two cannot disagree
 * about what "done" means.
 */
export const isDocumentV3 = (document: unknown): boolean => {
	if (!isRecord(document) || !Array.isArray(document.widgets)) return true

	return document.widgets.every((widget) => {
		if (!isRecord(widget)) return true
		if (widget.dataSource !== undefined && !isV3DataSource(widget.dataSource)) return false

		const display = widget.display
		if (!isRecord(display)) return true
		const sparkline = display.sparkline
		if (!isRecord(sparkline) || sparkline.dataSource === undefined) return true
		return isV3DataSource(sparkline.dataSource)
	})
}
