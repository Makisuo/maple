import { Atom } from "@/lib/effect-atom"
import { Schema } from "effect"
import { localStorageRuntime } from "@/lib/services/common/storage-runtime"

export interface ServiceMapLayoutSnapshot {
	/**
	 * The layout signature these positions were captured against (topology +
	 * namespace assignment + spacing config + declutter state + engine version).
	 * Positions are only honoured while this still matches the live layout —
	 * stale absolute coordinates would scatter nodes out of their clusters.
	 */
	signature: string
	positions: Record<string, { x: number; y: number }>
	viewport: { x: number; y: number; zoom: number } | null
}

/**
 * Small LRU of layout snapshots (most-recent first), so toggling declutter
 * state (traffic filter / focus-hide / collapse — each changes the signature)
 * round-trips manual arrangements instead of stomping a single stored one.
 */
export interface ServiceMapLayout {
	snapshots: ReadonlyArray<ServiceMapLayoutSnapshot>
}

export const SNAPSHOT_LIMIT = 4

const Position = Schema.Struct({ x: Schema.Number, y: Schema.Number })
const Viewport = Schema.Struct({ x: Schema.Number, y: Schema.Number, zoom: Schema.Number })

const SnapshotSchema = Schema.Struct({
	signature: Schema.String,
	positions: Schema.Record(Schema.String, Position),
	viewport: Schema.NullOr(Viewport),
})

// Pre-snapshot localStorage entries ({positions, viewport, signature?}) fail to
// decode and fall back to the default — intentional: they were captured against
// the pre-ELK flat layout and would scatter nodes anyway.
const ServiceMapLayoutSchema = Schema.Struct({
	snapshots: Schema.Array(SnapshotSchema),
}) as Schema.Codec<ServiceMapLayout>

const DEFAULT: ServiceMapLayout = { snapshots: [] }

/** Upsert `signature`'s snapshot at the front of the LRU, capped at {@link SNAPSHOT_LIMIT}. */
export function upsertSnapshot(
	layout: ServiceMapLayout,
	signature: string,
	update: (snapshot: ServiceMapLayoutSnapshot) => ServiceMapLayoutSnapshot,
): ServiceMapLayout {
	const existing = layout.snapshots.find((s) => s.signature === signature) ?? {
		signature,
		positions: {},
		viewport: null,
	}
	const rest = layout.snapshots.filter((s) => s.signature !== signature)
	return { snapshots: [update(existing), ...rest].slice(0, SNAPSHOT_LIMIT) }
}

export const serviceMapLayoutAtomFamily = Atom.family((orgId: string) =>
	Atom.kvs({
		runtime: localStorageRuntime,
		key: `maple.service-map.layout.${orgId}`,
		schema: ServiceMapLayoutSchema,
		defaultValue: () => DEFAULT,
	}),
)
