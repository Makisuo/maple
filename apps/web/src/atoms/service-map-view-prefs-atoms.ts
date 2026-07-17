import { Atom } from "@/lib/effect-atom"
import { Schema } from "effect"
import { localStorageRuntime } from "@/lib/services/common/storage-runtime"

/**
 * Per-org service-map declutter preferences that should survive reloads:
 * the low-traffic threshold and which namespaces are collapsed. Focus is
 * navigational and lives in the URL instead.
 */
export interface ServiceMapViewPrefs {
	/** 0 = off; otherwise hide edges under this % of the peak edge rate. */
	minTrafficPct: number
	collapsedNamespaces: ReadonlyArray<string>
}

const ServiceMapViewPrefsSchema = Schema.Struct({
	minTrafficPct: Schema.Number,
	collapsedNamespaces: Schema.Array(Schema.String),
}) as Schema.Codec<ServiceMapViewPrefs>

const DEFAULT: ServiceMapViewPrefs = { minTrafficPct: 0, collapsedNamespaces: [] }

export const serviceMapViewPrefsAtomFamily = Atom.family((orgId: string) =>
	Atom.kvs({
		runtime: localStorageRuntime,
		key: `maple.service-map.view-prefs.${orgId}`,
		schema: ServiceMapViewPrefsSchema,
		defaultValue: () => DEFAULT,
	}),
)
