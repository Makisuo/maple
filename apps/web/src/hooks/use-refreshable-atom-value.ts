import { Atom, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import * as React from "react"

import { useOptionalPageRefreshContext } from "@/components/time-range-picker/page-refresh-context"
import { useMountEffect } from "@/hooks/use-mount-effect"

export function useRefreshableAtomValue<A>(atom: Atom.Atom<A>): A {
	const value = useAtomValue(atom)
	const refresh = useAtomRefresh(atom)
	const pageRefresh = useOptionalPageRefreshContext()
	const refreshAtom = React.useEffectEvent(() => refresh())

	useMountEffect(() => {
		// React Doctor cannot infer that useMountEffect is an Effect; this is the
		// canonical Effect Event pattern for a mount-scoped external subscription.
		// oxlint-disable-next-line react-doctor/rules-of-hooks
		const onReload = () => refreshAtom()
		return pageRefresh?.subscribeReload(onReload)
	})

	return value
}
