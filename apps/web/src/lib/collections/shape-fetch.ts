import {
	createEffectCollection,
	type EffectElectricCollectionConfig,
	type Row,
} from "@maple/effect-db/electric"
import type { ManagedRuntime, Schema } from "effect"
import { mapleRuntime } from "@/lib/registry"
import { electricSyncBaseUrl } from "@/lib/services/common/electric-sync-url"
import { getMapleAuthHeaders } from "@/lib/services/common/auth-headers"

/**
 * URL of the standalone `apps/electric-sync` ElectricSQL shape proxy. Every
 * collection points its ShapeStream here with `?shape=<name>`; the proxy
 * authenticates, injects the org scope, and forwards to Electric. Never point a
 * ShapeStream at Electric directly — it has no auth.
 */
export const shapeProxyUrl = `${electricSyncBaseUrl}/api/sync/shape`

/**
 * `fetchClient` for every ShapeStream. Mirrors `mapleFetch` in http-client.ts
 * (which isn't exported): injects the Clerk / self-hosted bearer on requests to
 * the API so the proxy can resolve the tenant, exactly like the rest of the app.
 *
 * We deliberately do NOT impose our own timeout: Electric `live` requests
 * long-poll (~20s) and the ShapeStream manages its own AbortController and
 * backoff, so we pass `init.signal` straight through.
 */
export const mapleShapeFetch: typeof globalThis.fetch = async (input, init) => {
	const headers = new Headers(init?.headers)
	const authHeaders = await getMapleAuthHeaders()
	for (const [name, value] of Object.entries(authHeaders)) {
		if (!headers.has(name)) headers.set(name, value)
	}
	return globalThis.fetch(input, { ...init, headers })
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
	parser?: SyncedConfig<A>["shapeOptions"]["parser"]
	onUpdate?: SyncedConfig<A>["onUpdate"]
	onDelete?: SyncedConfig<A>["onDelete"]
}) =>
	createEffectCollection<A, MapleRuntimeR>({
		id: `${config.shape}:${config.orgId}`,
		runtime: mapleRuntime,
		schema: config.schema,
		getKey: config.getKey,
		shapeOptions: {
			url: shapeProxyUrl,
			params: { shape: config.shape },
			fetchClient: mapleShapeFetch,
			...(config.parser ? { parser: config.parser } : {}),
		},
		...(config.onUpdate ? { onUpdate: config.onUpdate } : {}),
		...(config.onDelete ? { onDelete: config.onDelete } : {}),
	})
