"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { DotMatrixPhase } from "@/lib/dotmatrix-core"

interface UseDotMatrixPhasesOptions {
	animated?: boolean
	hoverAnimated?: boolean
	speed?: number
}

interface DotMatrixPhasesResult {
	phase: DotMatrixPhase
	onMouseEnter: () => void
	onMouseLeave: () => void
}

export function useDotMatrixPhases({
	animated = false,
	hoverAnimated = false,
	speed = 1,
}: UseDotMatrixPhasesOptions): DotMatrixPhasesResult {
	const safeSpeed = speed > 0 ? speed : 1
	const autoRun = Boolean(animated && !hoverAnimated)
	const [hoverPhase, setHoverPhase] = useState<DotMatrixPhase>("idle")
	const timeouts = useRef<number[]>([])
	const hoverGen = useRef(0)

	const clearTimers = useCallback(() => {
		for (let i = 0; i < timeouts.current.length; i += 1) {
			window.clearTimeout(timeouts.current[i]!)
		}
		timeouts.current = []
	}, [])

	useEffect(() => {
		hoverGen.current += 1
		clearTimers()
		return clearTimers
	}, [autoRun, hoverAnimated, clearTimers])

	const onMouseEnter = useCallback(() => {
		if (!hoverAnimated || autoRun) {
			return
		}
		clearTimers()
		const gen = ++hoverGen.current
		setHoverPhase("collapse")
		const collapseMs = Math.max(1, Math.round(300 / safeSpeed))
		const id = window.setTimeout(() => {
			if (hoverGen.current !== gen) {
				return
			}
			setHoverPhase("hoverRipple")
		}, collapseMs)
		timeouts.current.push(id)
	}, [hoverAnimated, autoRun, safeSpeed, clearTimers])

	const onMouseLeave = useCallback(() => {
		if (!hoverAnimated || autoRun) {
			return
		}
		hoverGen.current += 1
		clearTimers()
		setHoverPhase("idle")
	}, [hoverAnimated, autoRun, clearTimers])

	const phase: DotMatrixPhase = autoRun ? "loadingRipple" : hoverAnimated ? hoverPhase : "idle"

	return useMemo(
		() => ({
			phase,
			onMouseEnter,
			onMouseLeave,
		}),
		[phase, onMouseEnter, onMouseLeave],
	)
}
