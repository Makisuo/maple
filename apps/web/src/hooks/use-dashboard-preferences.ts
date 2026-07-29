import { useCallback, useMemo } from "react"
import { useAtom } from "@/lib/effect-atom"
import {
	dashboardFavoritesAtom,
	dashboardSortAtom,
	isDashboardSortOption,
	type DashboardSortOption,
} from "@/atoms/dashboard-preferences-atoms"

/**
 * Device-local dashboard preferences: which dashboards are starred, and the sort
 * to fall back to when the URL carries no `?sort`. Both live in localStorage, so
 * favorites are per-browser and invisible to teammates — the list says so beside
 * the Favorites header rather than implying shared state.
 *
 * Search / scope / tags / sort selection are URL-owned and live on the route, not
 * here. Sorting itself is `sortDashboards` in dashboard-summary.ts, which
 * deliberately does *not* hoist favorites — the Favorites section already does.
 */
export function useDashboardPreferences() {
	const [favorites, setFavorites] = useAtom(dashboardFavoritesAtom)
	const [storedSort, setStoredSort] = useAtom(dashboardSortAtom)

	const favoritesSet = useMemo(() => new Set(favorites), [favorites])

	const toggleFavorite = useCallback(
		(dashboardId: string) => {
			setFavorites((prev) =>
				prev.includes(dashboardId) ? prev.filter((id) => id !== dashboardId) : [...prev, dashboardId],
			)
		},
		[setFavorites],
	)

	return {
		favorites: favoritesSet,
		toggleFavorite,
		/** Fallback sort for when `?sort` is absent. */
		defaultSort: isDashboardSortOption(storedSort) ? storedSort : ("updated" as DashboardSortOption),
		setDefaultSort: (sort: DashboardSortOption) => setStoredSort(sort),
	}
}
