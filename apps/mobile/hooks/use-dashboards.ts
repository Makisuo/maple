import { useCallback, useEffect, useRef, useState } from "react"
import { fetchDashboards, type DashboardDocument } from "../lib/api"

type DashboardsState =
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "success"; data: DashboardDocument[] }

export function useDashboards() {
	const [state, setState] = useState<DashboardsState>({ status: "loading" })
	const abortRef = useRef<AbortController | null>(null)

	const load = useCallback(async () => {
		abortRef.current?.abort()
		const controller = new AbortController()
		abortRef.current = controller

		setState({ status: "loading" })

		try {
			const dashboards = await fetchDashboards()
			if (controller.signal.aborted) return

			const sorted = [...dashboards].sort((a, b) =>
				b.updatedAt.localeCompare(a.updatedAt),
			)
			setState({ status: "success", data: sorted })
		} catch (err) {
			if (controller.signal.aborted) return
			setState({
				status: "error",
				error: err instanceof Error ? err.message : "Unknown error",
			})
		}
	}, [])

	useEffect(() => {
		load()
		return () => abortRef.current?.abort()
	}, [load])

	return { state, refresh: load }
}
