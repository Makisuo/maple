import { useCallback, useMemo, useState } from "react"
import { boundsForRange } from "../lib/time"

/** One page-owned time window shared by the log list and all of its facets. */
export function useLogTimeWindow(range: string | undefined) {
	const [anchorMs, setAnchorMs] = useState(() => Date.now())
	const bounds = useMemo(() => boundsForRange(range, anchorMs), [anchorMs, range])
	const advance = useCallback(() => setAnchorMs(Date.now()), [])

	return { bounds, advance }
}
