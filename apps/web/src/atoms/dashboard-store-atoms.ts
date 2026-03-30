import { Atom } from "@/lib/effect-atom"
import type { Dashboard } from "@/components/dashboard-builder/types"

export const dashboardsAtom = Atom.make<Dashboard[]>([])
export const persistenceErrorAtom = Atom.make<string | null>(null)
