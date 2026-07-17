import { DashboardDocument, DashboardId } from "@maple/domain/http"
import type { V2DashboardUpdateParams } from "@maple/domain/http/v2"
import { Effect, Schema } from "effect"
import type { Dashboard } from "@/components/dashboard-builder/types"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { createSyncedCollection } from "./shape-fetch"

/**
 * Raw ElectricSQL row for `dashboards` (snake_case, as it arrives on the shape
 * stream). `payload_json` is the full {@link DashboardDocument}; `version` is the
 * server CAS token. Collections hold raw rows and map to domain types in
 * selectors — Electric has no row-mapping hook and a transforming schema would
 * split the optimistic write's input/output types.
 *
 * The schema is *identity* (Type === Encoded, no camelCase transform): it exists
 * only to validate the shape stream's row shape so a post-deploy column drift
 * surfaces as a `SchemaValidationError` (→ the collection factory's self-heal),
 * not to reshape the data. Its fields mirror the `dashboards` pgTable exactly.
 */
export const DashboardRowSchema = Schema.Struct({
	org_id: Schema.String,
	id: Schema.String,
	name: Schema.String,
	payload_json: Schema.Unknown,
	created_at: Schema.String,
	updated_at: Schema.String,
	created_by: Schema.String,
	updated_by: Schema.String,
	version: Schema.Number,
})

export type DashboardRow = typeof DashboardRowSchema.Type

const asDashboardId = Schema.decodeUnknownSync(DashboardId)
const decodeDashboardDocumentUnknown = Schema.decodeUnknownSync(DashboardDocument)

// The @electric-sql/client default parser JSON.parses jsonb columns, so
// `payload_json` normally arrives as an object. Normalize defensively (a raw
// string can appear if a non-default parser is ever configured) before decoding.
const decodeDashboardDocument = (payloadJson: unknown) =>
	decodeDashboardDocumentUnknown(typeof payloadJson === "string" ? JSON.parse(payloadJson) : payloadJson)

/**
 * Widens a decoded domain {@link DashboardDocument} into the mutable web
 * {@link Dashboard} shape, copying its readonly `tags`/`widgets`/`variables`
 * arrays. Shared by `rowToDashboard` (Electric path) and `ensureDashboard`
 * (use-dashboard-store) — they decode from different sources but widen identically.
 */
export const documentToDashboard = (document: DashboardDocument): Dashboard => ({
	...document,
	tags: document.tags ? [...document.tags] : undefined,
	widgets: [...document.widgets] as Dashboard["widgets"],
	variables: document.variables ? ([...document.variables] as Dashboard["variables"]) : undefined,
})

// Memoize the payload decode so a re-render (or a live-query re-run) over an
// unchanged row doesn't re-parse its jsonb. Keyed on the row's payload_json
// object identity — Electric hands us a fresh object only when the row changes.
const dashboardCache = new WeakMap<object, Dashboard>()

/**
 * Decodes a raw row's `payload_json` into the mutable web {@link Dashboard}
 * shape (widening the domain document's readonly arrays), mirroring
 * `ensureDashboard` in use-dashboard-store.ts. Returns null on an undecodable
 * payload so a single corrupt row can't crash the list.
 */
export const rowToDashboard = (row: DashboardRow): Dashboard | null => {
	if (typeof row.payload_json === "object" && row.payload_json !== null) {
		const cached = dashboardCache.get(row.payload_json)
		if (cached) return cached
	}
	try {
		const dashboard = documentToDashboard(decodeDashboardDocument(row.payload_json))
		if (typeof row.payload_json === "object" && row.payload_json !== null) {
			dashboardCache.set(row.payload_json, dashboard)
		}
		return dashboard
	} catch {
		return null
	}
}

/**
 * Builds the v2 PATCH payload from a row's optimistic `payload_json`. The stored
 * payload never carries `txid` (the API strips it), so nothing to omit here.
 */
const rowToUpdateRequest = (row: DashboardRow): V2DashboardUpdateParams => {
	const dashboard = decodeDashboardDocument(row.payload_json)
	return {
		name: dashboard.name,
		description: dashboard.description ?? null,
		tags: dashboard.tags ?? [],
		timeRange: dashboard.timeRange,
		widgets: dashboard.widgets,
		variables: dashboard.variables ?? [],
	}
}

// The API attaches a txid on every successful dashboard write (readTxid over the
// mutating statement), but `txid` is `Schema.optionalKey` on the response types,
// so it's typed `string | undefined`. `@maple/effect-db`'s handler requires a
// truthy txid and rejects otherwise, and `Number(undefined)` is `NaN` — which
// would roll back a write that actually succeeded. Fail explicitly on the missing
// case (never observed for dashboards) instead of silently producing NaN.
const requireTxid = (txid: string | undefined): Effect.Effect<number> =>
	txid === undefined
		? Effect.die(new Error("Dashboard write succeeded but the server returned no txid"))
		: Effect.succeed(Number(txid))

/**
 * Creates the per-org dashboards collection via `@maple/effect-db`'s
 * `createEffectCollection`: an identity {@link DashboardRowSchema} validates the
 * shape stream, and the write handlers are Effect programs run on the shared
 * {@link mapleRuntime} (traced + backoff + stale-cache self-heal). The id embeds
 * the org so a switch mints a fresh collection (discarding the previous org's
 * shape handle/offset) rather than colliding. Writes go through the public v2 HTTP
 * API and return the Postgres txid, which TanStack DB awaits on the shape stream
 * before dropping optimistic state.
 */
export const createDashboardsCollection = (orgId: string) =>
	createSyncedCollection({
		shape: "dashboards",
		orgId,
		schema: DashboardRowSchema,
		getKey: (row) => row.id,
		onUpdate: ({ transaction }) =>
			Effect.gen(function* () {
				const client = yield* MapleApiV2AtomClient
				const { modified } = transaction.mutations[0]
				const result = yield* client.dashboards.update({
					params: { id: asDashboardId(modified.id) },
					payload: rowToUpdateRequest(modified),
				})
				return { txid: yield* requireTxid(result.txid) }
			}),
		onDelete: ({ transaction }) =>
			Effect.gen(function* () {
				const client = yield* MapleApiV2AtomClient
				const { original } = transaction.mutations[0]
				const result = yield* client.dashboards.delete({
					params: { id: asDashboardId(original.id) },
				})
				return { txid: yield* requireTxid(result.txid) }
			}),
	})

export type DashboardsCollection = ReturnType<typeof createDashboardsCollection>
