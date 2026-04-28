import { Atom, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import * as React from "react"

import { useOptionalPageRefreshContext } from "@/components/time-range-picker/page-refresh-context"

export function useRefreshableAtomValue<A>(atom: Atom.Atom<A>): A {
	const value = useAtomValue(atom)
	const refresh = useAtomRefresh(atom)
	const pageRefresh = useOptionalPageRefreshContext()
	const refreshVersion = pageRefresh?.refreshVersion ?? 0
	const lastSeenVersion = React.useRef(refreshVersion)

	if (pageRefresh && refreshVersion !== lastSeenVersion.current) {
		lastSeenVersion.current = refreshVersion
		queueMicrotask(refresh)
	}

	return value
}
