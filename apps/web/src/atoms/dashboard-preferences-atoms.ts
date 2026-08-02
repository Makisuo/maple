import { Atom } from "@/lib/effect-atom"
import { Schema } from "effect"
import { localStorageRuntime } from "@/lib/services/common/storage-runtime"

export type DashboardSortOption = "updated" | "created" | "name-asc" | "name-desc" | "widgets"

export const DASHBOARD_SORT_OPTIONS = [
	"updated",
	"created",
	"name-asc",
	"name-desc",
	"widgets",
] as const satisfies ReadonlyArray<DashboardSortOption>

export const isDashboardSortOption = (value: string): value is DashboardSortOption =>
	(DASHBOARD_SORT_OPTIONS as ReadonlyArray<string>).includes(value)

export const dashboardFavoritesAtom = Atom.kvs({
	runtime: localStorageRuntime,
	key: "maple.dashboards.favorites",
	schema: Schema.Array(Schema.String),
	defaultValue: () => [] as readonly string[],
})

/**
 * The sort the list falls back to when the URL carries no `?sort`. Sort, search,
 * scope and tags are all URL-owned so the view is linkable and back-navigable;
 * this only remembers the user's preferred default across cold loads.
 */
export const dashboardSortAtom = Atom.kvs({
	runtime: localStorageRuntime,
	key: "maple.dashboards.sort",
	schema: Schema.String,
	defaultValue: () => "updated" as string,
})
