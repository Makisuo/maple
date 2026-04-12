import { Atom } from "@/lib/effect-atom"
import { Schema } from "effect"
import { localStorageRuntime } from "@/lib/services/common/storage-runtime"

export type DashboardSortOption = "updated" | "created" | "name-asc" | "name-desc" | "widgets"

export const dashboardFavoritesAtom = Atom.kvs({
  runtime: localStorageRuntime,
  key: "maple.dashboards.favorites",
  schema: Schema.Array(Schema.String),
  defaultValue: () => [] as readonly string[],
})

export const dashboardSortAtom = Atom.kvs({
  runtime: localStorageRuntime,
  key: "maple.dashboards.sort",
  schema: Schema.String,
  defaultValue: () => "updated" as string,
})

export const dashboardTagFilterAtom = Atom.make<string | null>(null)
