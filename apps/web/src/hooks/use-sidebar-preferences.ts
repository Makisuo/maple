import { useCallback } from "react"
import { useAtom } from "@/lib/effect-atom"
import {
	LOCKED_NAV_IDS,
	defaultSidebarPrefs,
	sidebarPrefsAtom,
	type SidebarPrefs,
} from "@/atoms/sidebar-preferences-atoms"

export function useSidebarPreferences() {
	const [prefs, setPrefs] = useAtom(sidebarPrefsAtom)

	const toggleHidden = useCallback(
		(itemId: string) => {
			if (LOCKED_NAV_IDS.has(itemId)) return
			setPrefs((prev: SidebarPrefs) => {
				const hidden = prev.hidden.includes(itemId)
					? prev.hidden.filter((id) => id !== itemId)
					: [...prev.hidden, itemId]
				return { ...prev, hidden }
			})
		},
		[setPrefs],
	)

	const setGroupOrder = useCallback(
		(groupId: string, ids: readonly string[]) => {
			setPrefs((prev: SidebarPrefs) => ({ ...prev, order: { ...prev.order, [groupId]: ids } }))
		},
		[setPrefs],
	)

	const resetToDefaults = useCallback(() => {
		setPrefs(defaultSidebarPrefs)
	}, [setPrefs])

	const isCustomized = prefs.hidden.length > 0 || Object.keys(prefs.order).length > 0

	return { prefs, toggleHidden, setGroupOrder, resetToDefaults, isCustomized }
}
