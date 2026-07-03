import { createCollection } from "@tanstack/db"
import { electricCollectionOptions } from "@tanstack/electric-db-collection"
import { Schema } from "effect"
import { DashboardDocument, DashboardId, DashboardUpsertRequest } from "@maple/domain/http"
import type { Dashboard } from "@/components/dashboard-builder/types"
import { runMapleApi } from "./api-runner"
import { mapleShapeFetch, shapeProxyUrl } from "./shape-fetch"

/**
 * Raw ElectricSQL row for `dashboards` (snake_case, as it arrives on the shape
 * stream). `payload_json` is the full {@link DashboardDocument}; `version` is the
 * server CAS token. Collections hold raw rows and map to domain types in
 * selectors — Electric has no row-mapping hook and a transforming schema would
 * split the optimistic write's input/output types.
 */
export type DashboardRow = {
	readonly org_id: string
	readonly id: string
	readonly name: string
	readonly payload_json: unknown
	readonly created_at: string
	readonly updated_at: string
	readonly created_by: string
	readonly updated_by: string
	readonly version: number
}

const asDashboardId = Schema.decodeUnknownSync(DashboardId)
const decodeDashboardDocument = Schema.decodeUnknownSync(DashboardDocument)

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
		const document = decodeDashboardDocument(row.payload_json)
		const dashboard: Dashboard = {
			...document,
			tags: document.tags ? [...document.tags] : undefined,
			widgets: [...document.widgets] as Dashboard["widgets"],
			variables: document.variables
				? ([...document.variables] as Dashboard["variables"])
				: undefined,
		}
		if (typeof row.payload_json === "object" && row.payload_json !== null) {
			dashboardCache.set(row.payload_json, dashboard)
		}
		return dashboard
	} catch {
		return null
	}
}

/**
 * Builds the upsert payload from a row's optimistic `payload_json`. The stored
 * payload never carries `txid` (the API strips it), so nothing to omit here.
 */
const rowToUpsertRequest = (row: DashboardRow): DashboardUpsertRequest =>
	new DashboardUpsertRequest({ dashboard: decodeDashboardDocument(row.payload_json) })

const readTxid = (value: { readonly txid?: string }): number | undefined =>
	value.txid !== undefined ? Number(value.txid) : undefined

/**
 * Creates the per-org dashboards collection. The id embeds the org so a switch
 * mints a fresh collection (discarding the previous org's shape handle/offset)
 * rather than colliding. Writes go through the existing HTTP API and return the
 * Postgres txid, which TanStack DB awaits on the shape stream before dropping
 * optimistic state.
 */
export const createDashboardsCollection = (orgId: string) =>
	createCollection(
		electricCollectionOptions<DashboardRow>({
			id: `dashboards:${orgId}`,
			shapeOptions: {
				url: shapeProxyUrl,
				params: { shape: "dashboards" },
				fetchClient: mapleShapeFetch,
			},
			getKey: (row) => row.id,
			onUpdate: async ({ transaction }) => {
				const { modified } = transaction.mutations[0]
				const result = await runMapleApi((client) =>
					client.dashboards.upsert({
						params: { dashboardId: asDashboardId(modified.id) },
						payload: rowToUpsertRequest(modified),
					}),
				)
				const txid = readTxid(result)
				return txid === undefined ? undefined : { txid }
			},
			onDelete: async ({ transaction }) => {
				const { original } = transaction.mutations[0]
				const result = await runMapleApi((client) =>
					client.dashboards.delete({
						params: { dashboardId: asDashboardId(original.id) },
					}),
				)
				const txid = readTxid(result)
				return txid === undefined ? undefined : { txid }
			},
		}),
	)

export type DashboardsCollection = ReturnType<typeof createDashboardsCollection>
