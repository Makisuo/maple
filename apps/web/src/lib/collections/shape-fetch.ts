import {
	createEffectCollection,
	type EffectElectricCollectionConfig,
	type Row,
} from "@maple/effect-db/electric"
import type { ManagedRuntime, Schema } from "effect"
import { mapleRuntime } from "@/lib/registry"
import { electricSyncBaseUrl } from "@/lib/services/common/electric-sync-url"
import { getMapleAuthHeaders } from "@/lib/services/common/auth-headers"
import { tracedFetch } from "@/lib/services/common/telemetry"

/**
 * URL of the standalone `apps/electric-sync` ElectricSQL shape proxy. Every
 * collection points its ShapeStream here with `?shape=<name>&org=<id>`; the proxy
 * authenticates, injects the org scope from the BEARER (never from `org=`, which
 * is there for cache keying only — see `createSyncedCollection`), and forwards to
 * Electric. Never point a ShapeStream at Electric directly — it has no auth.
 */
export const syncProxyUrl = `${electricSyncBaseUrl}/api/sync/shape`

/**
 * `fetchClient` for every ShapeStream. Mirrors `mapleFetch` in http-client.ts
 * (which isn't exported): injects the Clerk / self-hosted bearer on requests to
 * the API so the proxy can resolve the tenant, exactly like the rest of the app.
 *
 * We deliberately do NOT impose our own timeout: Electric `live` requests
 * long-poll (~20s) and the ShapeStream manages its own AbortController and
 * backoff, so we pass `init.signal` straight through.
 */
export const mapleSyncFetch: typeof globalThis.fetch = async (input, init) => {
	const headers = new Headers(init?.headers)
	const authHeaders = await getMapleAuthHeaders()
	for (const [name, value] of Object.entries(authHeaders)) {
		if (!headers.has(name)) headers.set(name, value)
	}
	return tracedFetch("electric-sync", input, { ...init, headers })
}

/**
 * Every timestamptz column arrives from Electric as a raw Postgres string; this
 * parser normalizes it to ISO so the row-schema String fields decode straight to
 * the domain Document's branded `IsoDateTimeString`. Shared by every
 * timestamptz-bearing shape (alerts, errors).
 */
export const timestamptzParser = { timestamptz: (v: string) => new Date(v).toISOString() }

// Service requirement (R) of the shared app runtime — collection write handlers
// yield `MapleApiAtomClient`, which this runtime provides.
type MapleRuntimeR = typeof mapleRuntime extends ManagedRuntime.ManagedRuntime<infer R, any> ? R : never
type SyncedConfig<A extends Row<unknown>> = EffectElectricCollectionConfig<
	A,
	string | number,
	never,
	Record<string, never>,
	MapleRuntimeR
>

/**
 * Fills in the scaffolding every Maple synced collection shares — the shared
 * runtime, the shape-proxy url + auth `fetchClient`, and the `<shape>:<org>` id
 * (which pins the collection to one org so an org switch mints a fresh one). A
 * collection factory then declares only what varies: the shape name, row schema,
 * key, and (dashboards only) an optional `parser` + write handlers.
 */
export const createSyncedCollection = <A extends Row<unknown>>(config: {
	shape: string
	orgId: string
	schema: Schema.Schema<A>
	getKey: (row: A) => string
	/**
	 * Narrows a scoped shape to one row's worth of subtree (today: one
	 * investigation). The proxy pins which column this compares against and binds
	 * the value positionally — the client only ever supplies the value. It also
	 * joins the collection id, so two investigations open in two tabs do not share
	 * one shape handle.
	 */
	scope?: string
	parser?: SyncedConfig<A>["shapeOptions"]["parser"]
	onUpdate?: SyncedConfig<A>["onUpdate"]
	onDelete?: SyncedConfig<A>["onDelete"]
}) =>
	createEffectCollection<A, MapleRuntimeR>({
		id: config.scope
			? `${config.shape}:${config.orgId}:${config.scope}`
			: `${config.shape}:${config.orgId}`,
		runtime: mapleRuntime,
		schema: config.schema,
		getKey: config.getKey,
		shapeOptions: {
			url: syncProxyUrl,
			params: {
				shape: config.shape,
				// Present so the URL differs per tenant, and read by NOBODY: the proxy
				// forwards only Electric's own cursor params and derives the org from
				// the bearer, so this cannot widen what a client can reach.
				//
				// It exists because the URL is a cache key in three places that are all
				// org-blind without it. The ShapeStream derives its internal shape key
				// from this URL minus the cursor params, and that key indexes a
				// `localStorage` map of expired shape handles (`electric_expired_shapes`,
				// no TTL) shared by every org a user visits — one org's dead handle rode
				// along on another's requests and tripped the client's stale-cache
				// detector. The browser's HTTP cache and any intermediary key on it too,
				// where `Vary: Authorization` was the only thing keeping tenants apart.
				org: config.orgId,
				...(config.scope ? { scope: config.scope } : undefined),
			},
			fetchClient: mapleSyncFetch,
			...(config.parser ? { parser: config.parser } : undefined),
		},
		...(config.onUpdate ? { onUpdate: config.onUpdate } : undefined),
		...(config.onDelete ? { onDelete: config.onDelete } : undefined),
	})
