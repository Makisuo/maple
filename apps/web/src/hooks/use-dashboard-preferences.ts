import { useCallback, useMemo } from "react"
import { useAtom } from "@/lib/effect-atom"
import {
  dashboardFavoritesAtom,
  dashboardSortAtom,
  dashboardTagFilterAtom,
  type DashboardSortOption,
} from "@/atoms/dashboard-preferences-atoms"
import type { Dashboard } from "@/components/dashboard-builder/types"

export function useDashboardPreferences() {
  const [favorites, setFavorites] = useAtom(dashboardFavoritesAtom)
  const [sortOption, setSortOption] = useAtom(dashboardSortAtom)
  const [tagFilter, setTagFilter] = useAtom(dashboardTagFilterAtom)

  const favoritesSet = useMemo(() => new Set(favorites), [favorites])

  const toggleFavorite = useCallback(
    (dashboardId: string) => {
      setFavorites((prev) => {
        const current = [...prev]
        const index = current.indexOf(dashboardId)
        if (index >= 0) {
          current.splice(index, 1)
        } else {
          current.push(dashboardId)
        }
        return current
      })
    },
    [setFavorites],
  )

  const isFavorite = useCallback(
    (dashboardId: string) => favoritesSet.has(dashboardId),
    [favoritesSet],
  )

  const sortAndFilter = useCallback(
    (dashboards: Dashboard[]) => {
      let filtered = dashboards
      if (tagFilter) {
        filtered = dashboards.filter((d) => d.tags?.includes(tagFilter))
      }

      const sorted = [...filtered].sort((a, b) => {
        const aFav = favoritesSet.has(a.id) ? 0 : 1
        const bFav = favoritesSet.has(b.id) ? 0 : 1
        if (aFav !== bFav) return aFav - bFav

        const sort = sortOption as DashboardSortOption
        switch (sort) {
          case "name-asc":
            return a.name.localeCompare(b.name)
          case "name-desc":
            return b.name.localeCompare(a.name)
          case "created":
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          case "widgets":
            return b.widgets.length - a.widgets.length
          case "updated":
          default:
            return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        }
      })

      return sorted
    },
    [favoritesSet, sortOption, tagFilter],
  )

  const allTags = useCallback(
    (dashboards: Dashboard[]) => {
      const tags = new Set<string>()
      for (const d of dashboards) {
        if (d.tags) {
          for (const t of d.tags) tags.add(t)
        }
      }
      return Array.from(tags).sort()
    },
    [],
  )

  return {
    favorites: favoritesSet,
    sortOption: sortOption as DashboardSortOption,
    tagFilter,
    toggleFavorite,
    isFavorite,
    setSortOption: (opt: DashboardSortOption) => setSortOption(opt),
    setTagFilter,
    sortAndFilter,
    allTags,
  }
}
