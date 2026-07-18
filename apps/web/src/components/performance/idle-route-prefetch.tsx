import { useRouter } from "@tanstack/react-router"

import { useMountEffect } from "@/hooks/use-mount-effect"

const COMMON_ROUTE_PATHS = ["/", "/services/", "/traces/", "/logs/"] as const
const INITIAL_QUIET_PERIOD_MS = 1_200
const BETWEEN_ROUTES_MS = 250
const MIN_IDLE_TIME_MS = 8

interface ConnectionHints {
	readonly saveData?: boolean
	readonly effectiveType?: string
}

interface PerformanceNavigator extends Navigator {
	readonly connection?: ConnectionHints
	readonly scheduling?: {
		readonly isInputPending?: () => boolean
	}
}

function shouldAvoidBackgroundLoading() {
	const connection = (navigator as PerformanceNavigator).connection
	return (
		connection?.saveData === true ||
		connection?.effectiveType === "slow-2g" ||
		connection?.effectiveType === "2g"
	)
}

function hasPendingInput() {
	return (navigator as PerformanceNavigator).scheduling?.isInputPending?.() === true
}

function normalizedPath(path: string) {
	return path === "/" ? path : path.replace(/\/$/, "")
}

/**
 * Warm the four routes operators visit most often without adding them to the
 * startup import graph. Only component chunks are loaded: route loaders and
 * warehouse requests are deliberately not run.
 */
export function IdleRoutePrefetch() {
	const router = useRouter()

	useMountEffect(() => {
		if (shouldAvoidBackgroundLoading()) return

		const queue = COMMON_ROUTE_PATHS.filter(
			(path) => normalizedPath(path) !== normalizedPath(router.state.location.pathname),
		)
		let disposed = false
		let timeoutId: number | undefined
		let idleId: number | undefined

		const schedule = (delayMs: number) => {
			if (disposed || queue.length === 0) return
			timeoutId = window.setTimeout(() => {
				if (disposed) return

				const run = (deadline?: IdleDeadline) => {
					if (disposed) return
					if (
						document.visibilityState !== "visible" ||
						hasPendingInput() ||
						(deadline && !deadline.didTimeout && deadline.timeRemaining() < MIN_IDLE_TIME_MS)
					) {
						schedule(BETWEEN_ROUTES_MS)
						return
					}

					const path = queue.shift()
					if (!path) return
					const route = router.routesByPath[path]
					void Promise.resolve(router.loadRouteChunk(route))
						.catch(() => {
							// Prefetch is opportunistic. Navigation retains its normal chunk
							// loading/error path if the background request was interrupted.
						})
						.finally(() => schedule(BETWEEN_ROUTES_MS))
				}

				if (typeof window.requestIdleCallback === "function") {
					idleId = window.requestIdleCallback(run)
				} else {
					run()
				}
			}, delayMs)
		}

		schedule(INITIAL_QUIET_PERIOD_MS)

		return () => {
			disposed = true
			if (timeoutId !== undefined) window.clearTimeout(timeoutId)
			if (idleId !== undefined && typeof window.cancelIdleCallback === "function") {
				window.cancelIdleCallback(idleId)
			}
		}
	})

	return null
}
