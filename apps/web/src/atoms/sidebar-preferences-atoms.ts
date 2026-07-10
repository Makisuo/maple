import { Atom } from "@/lib/effect-atom"
import { Schema } from "effect"
import { localStorageRuntime } from "@/lib/services/common/storage-runtime"

export interface SidebarPrefs {
	/** Group id -> ordered item ids. Only groups the user has reordered. */
	order: Record<string, readonly string[]>
	/** Hidden item ids across all groups. */
	hidden: readonly string[]
}

const SidebarPrefsSchema = Schema.Struct({
	order: Schema.Record(Schema.String, Schema.Array(Schema.String)),
	hidden: Schema.Array(Schema.String),
}) as Schema.Codec<SidebarPrefs>

export const defaultSidebarPrefs: SidebarPrefs = { order: {}, hidden: [] }

// Decode failure falls back to defaultValue; bump the key on incompatible shape changes.
export const sidebarPrefsAtom = Atom.kvs({
	runtime: localStorageRuntime,
	key: "maple.sidebar.prefs",
	schema: SidebarPrefsSchema,
	defaultValue: () => defaultSidebarPrefs,
})

/** Items that can never be hidden or displaced from their default position. */
export const LOCKED_NAV_IDS: ReadonlySet<string> = new Set(["overview"])

/**
 * Merge a stored order with the current defaults:
 * - stored ids not in defaults are dropped (removed/gated-off items)
 * - default ids missing from stored are inserted at their default position,
 *   immediately after the nearest preceding default sibling already present
 *   (or at the front if none) — so items shipped in future releases show up
 *   where they belong instead of vanishing or piling up at the end.
 */
export function mergeOrder(defaults: readonly string[], stored: readonly string[]): string[] {
	const defaultSet = new Set(defaults)
	const result = stored.filter((id) => defaultSet.has(id))
	const present = new Set(result)
	for (let i = 0; i < defaults.length; i++) {
		const id = defaults[i]
		if (present.has(id)) continue
		let insertAt = 0
		for (let j = i - 1; j >= 0; j--) {
			const idx = result.indexOf(defaults[j])
			if (idx >= 0) {
				insertAt = idx + 1
				break
			}
		}
		result.splice(insertAt, 0, id)
		present.add(id)
	}
	return result
}

export interface SidebarNavRow<T> {
	item: T
	hidden: boolean
}

/**
 * Apply user prefs to one already-feature-gated group. Returns rows in display
 * order, each flagged hidden (edit mode shows hidden rows dimmed; normal mode
 * filters them out). Locked ids are never hidden and are pinned back to their
 * default index, so drops that displace them self-heal on the next render.
 */
export function applySidebarPrefs<T extends { id: string }>(
	groupId: string,
	items: readonly T[],
	prefs: SidebarPrefs,
	locked: ReadonlySet<string> = LOCKED_NAV_IDS,
): Array<SidebarNavRow<T>> {
	const defaults = items.map((item) => item.id)
	const orderIds = mergeOrder(defaults, prefs.order[groupId] ?? [])
	for (const id of defaults) {
		if (!locked.has(id)) continue
		const current = orderIds.indexOf(id)
		const target = Math.min(defaults.indexOf(id), orderIds.length - 1)
		if (current !== target) {
			orderIds.splice(current, 1)
			orderIds.splice(target, 0, id)
		}
	}
	const byId = new Map(items.map((item) => [item.id, item]))
	const hiddenSet = new Set(prefs.hidden)
	return orderIds.flatMap((id) => {
		const item = byId.get(id)
		if (!item) return []
		return [{ item, hidden: hiddenSet.has(id) && !locked.has(id) }]
	})
}
