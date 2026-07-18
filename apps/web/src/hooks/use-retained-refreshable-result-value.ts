import { Atom, Result } from "@/lib/effect-atom"
import * as React from "react"

import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"

export function useRetainedRefreshableResultValue<A, E>(
	atom: Atom.Atom<Result.Result<A, E>>,
): Result.Result<A, E> {
	const result = useRefreshableAtomValue(atom)
	const [retained, setRetained] = React.useState<{
		result: Result.Result<A, E>
		lastSuccess: Result.Success<A, E> | null
	}>(() => ({ result, lastSuccess: Result.isSuccess(result) ? result : null }))
	let lastSuccess = retained.lastSuccess

	if (result !== retained.result) {
		lastSuccess = Result.isSuccess(result) ? result : retained.lastSuccess
		setRetained({ result, lastSuccess })
	}

	return React.useMemo(() => {
		if (Result.isInitial(result) && lastSuccess) {
			return Result.success<A, E>(lastSuccess.value, {
				waiting: true,
				timestamp: lastSuccess.timestamp,
			})
		}

		return result
	}, [lastSuccess, result])
}
