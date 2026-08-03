import { createContext, useContext, useEffect, useRef } from "react"
import { useStoreApi } from "@xyflow/react"
import { useMediaQuery } from "@maple/ui/hooks/use-media-query"

/**
 * Canvas particle layer for the service map.
 *
 * The previous design animated per-edge SVG particles inside `feGaussianBlur`
 * filters (up to 16 SMIL `<animateMotion>` + a bloom filter per edge), which
 * re-rasterizes a filter region every frame on the main thread and scales with
 * traffic. This replaces all of that with a SINGLE `<canvas>` driven by one rAF
 * loop, plus a GLOBAL particle budget so total work is bounded no matter how
 * many edges or how much throughput the graph carries.
 */

// Hard cap on simultaneously-animated particles across the whole map. Distributed
// across edges proportional to their call rate (busiest edges win under pressure).
export const MAX_TOTAL_PARTICLES = 400
// Seconds a particle takes to traverse an edge (matches the prior visual cadence).
const TRAVERSE_TIME = 2
const MAX_DUR = 20
const MAX_PARTICLES_PER_EDGE = 8

export interface EdgeParticleSpec {
	pathString: string
	sourceColor: string
	callsPerSecond: number
	strokeWidth: number
}

/** Stable, mutable registry edges publish their geometry into (no React state). */
export interface ParticleRegistry {
	readonly map: Map<string, EdgeParticleSpec>
	set: (id: string, spec: EdgeParticleSpec) => void
	remove: (id: string) => void
}

export function createParticleRegistry(): ParticleRegistry {
	const map = new Map<string, EdgeParticleSpec>()
	return {
		map,
		set: (id, spec) => {
			map.set(id, spec)
		},
		remove: (id) => {
			map.delete(id)
		},
	}
}

const ParticleRegistryContext = createContext<ParticleRegistry | null>(null)

export const ParticleRegistryProvider = ParticleRegistryContext.Provider

export function useParticleRegistry(): ParticleRegistry | null {
	return useContext(ParticleRegistryContext)
}

/** Desired particle count for one edge from its call rate (pre-budget). */
function desiredParticles(callsPerSecond: number): number {
	const rate = Math.max(0, callsPerSecond)
	if (rate <= 0) return 0
	const interArrival = 1 / rate
	if (interArrival > TRAVERSE_TIME) return 1
	return Math.min(MAX_PARTICLES_PER_EDGE, Math.max(1, Math.round(rate * TRAVERSE_TIME)))
}

/** Traversal duration for one edge (seconds), matching the prior edge logic. */
function traversalDuration(callsPerSecond: number): number {
	const rate = Math.max(0, callsPerSecond)
	if (rate <= 0) return TRAVERSE_TIME
	const interArrival = 1 / rate
	return interArrival > TRAVERSE_TIME ? Math.min(interArrival, MAX_DUR) : TRAVERSE_TIME
}

/**
 * Distribute a global particle budget across edges proportional to call rate.
 *
 * If total desired ≤ `maxTotal`, every edge gets exactly what it wants. Otherwise
 * counts are scaled down via the largest-remainder method so the sum equals
 * `maxTotal` exactly — busiest edges keep their particles, sparse ones drop to 0.
 * Pure and deterministic (unit-tested).
 */
export function allocateParticleBudget(
	specs: Iterable<readonly [string, EdgeParticleSpec]>,
	maxTotal: number = MAX_TOTAL_PARTICLES,
): Map<string, number> {
	const desired: Array<[string, number]> = []
	let totalDesired = 0
	for (const [id, spec] of specs) {
		const d = desiredParticles(spec.callsPerSecond)
		desired.push([id, d])
		totalDesired += d
	}

	const result = new Map<string, number>()
	if (totalDesired <= maxTotal || totalDesired === 0) {
		for (const [id, d] of desired) result.set(id, d)
		return result
	}

	const scale = maxTotal / totalDesired
	const remainders: Array<[string, number]> = []
	let used = 0
	for (const [id, d] of desired) {
		if (d === 0) {
			result.set(id, 0)
			continue
		}
		const ideal = d * scale
		const floor = Math.floor(ideal)
		result.set(id, floor)
		used += floor
		remainders.push([id, ideal - floor])
	}
	// Hand out the leftover to the largest fractional remainders.
	remainders.sort((a, b) => b[1] - a[1])
	let remaining = maxTotal - used
	for (let i = 0; i < remainders.length && remaining > 0; i++) {
		const id = remainders[i][0]
		result.set(id, (result.get(id) ?? 0) + 1)
		remaining--
	}
	return result
}

// --- path sampling cache -----------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg"

interface CachedPath {
	el: SVGPathElement
	length: number
}

function getCachedPath(cache: Map<string, CachedPath>, pathString: string): CachedPath | null {
	let entry = cache.get(pathString)
	if (!entry) {
		const el = document.createElementNS(SVG_NS, "path")
		el.setAttribute("d", pathString)
		let length = 0
		try {
			length = el.getTotalLength()
		} catch {
			return null
		}
		entry = { el, length }
		cache.set(pathString, entry)
	}
	return entry
}

// Cheap deterministic 0..1 hash to phase-offset each edge's particle stream.
function hash01(str: string): number {
	let h = 0
	for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0
	return (Math.abs(h) % 1000) / 1000
}

/**
 * The single canvas overlay. Must render inside `<ReactFlow>` so it can read the
 * live viewport transform from the flow store. Reads the geometry registry every
 * frame — no React re-render in the animation loop.
 */
export function ServiceMapParticleCanvas() {
	const canvasRef = useRef<HTMLCanvasElement | null>(null)
	const store = useStoreApi()
	const registry = useParticleRegistry()
	const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)")

	useEffect(() => {
		if (reducedMotion || !registry) return
		const canvas = canvasRef.current
		if (!canvas) return
		const ctx = canvas.getContext("2d")
		if (!ctx) return

		const pathCache = new Map<string, CachedPath>()
		let raf = 0
		let cssW = 0
		let cssH = 0

		const resize = () => {
			const dpr = window.devicePixelRatio || 1
			cssW = canvas.clientWidth
			cssH = canvas.clientHeight
			canvas.width = Math.max(1, Math.round(cssW * dpr))
			canvas.height = Math.max(1, Math.round(cssH * dpr))
		}
		resize()
		const ro = new ResizeObserver(resize)
		ro.observe(canvas)

		const draw = (nowMs: number) => {
			raf = requestAnimationFrame(draw)
			const dpr = window.devicePixelRatio || 1
			// Clear in device space.
			ctx.setTransform(1, 0, 0, 1, 0, 0)
			ctx.clearRect(0, 0, canvas.width, canvas.height)

			const specs = registry.map
			if (specs.size === 0) return

			const [tx, ty, zoom] = store.getState().transform
			// Flow→device transform (combines viewport transform + DPR).
			ctx.setTransform(zoom * dpr, 0, 0, zoom * dpr, tx * dpr, ty * dpr)

			// Visible flow-space rect (for culling), with a margin.
			const margin = 40
			const viewLeft = -tx / zoom - margin
			const viewTop = -ty / zoom - margin
			const viewRight = viewLeft + cssW / zoom + margin * 2
			const viewBottom = viewTop + cssH / zoom + margin * 2

			const budget = allocateParticleBudget(specs)
			const t = nowMs / 1000

			for (const [id, spec] of specs) {
				const count = budget.get(id) ?? 0
				if (count <= 0 || !spec.pathString) continue
				const cached = getCachedPath(pathCache, spec.pathString)
				if (!cached || cached.length <= 0) continue

				const dur = traversalDuration(spec.callsPerSecond)
				const base = (t / dur + hash01(id)) % 1
				const r = Math.max(1.5, spec.strokeWidth * 0.5)

				for (let i = 0; i < count; i++) {
					let frac = base + i / count
					frac -= Math.floor(frac)
					const pt = cached.el.getPointAtLength(frac * cached.length)
					if (pt.x < viewLeft || pt.x > viewRight || pt.y < viewTop || pt.y > viewBottom) {
						continue
					}
					// Soft glow + bright core — cheap two-circle comet, no SVG filter.
					ctx.globalAlpha = 0.2
					ctx.fillStyle = spec.sourceColor
					ctx.beginPath()
					ctx.arc(pt.x, pt.y, r * 2.6, 0, Math.PI * 2)
					ctx.fill()
					ctx.globalAlpha = 0.95
					ctx.fillStyle = "#ffffff"
					ctx.beginPath()
					ctx.arc(pt.x, pt.y, r * 0.75, 0, Math.PI * 2)
					ctx.fill()
				}
			}
			ctx.globalAlpha = 1

			// Drop cache entries for paths no longer present (bounded memory).
			if (pathCache.size > specs.size * 2) {
				const live = new Set<string>()
				for (const spec of specs.values()) live.add(spec.pathString)
				for (const key of pathCache.keys()) if (!live.has(key)) pathCache.delete(key)
			}
		}

		raf = requestAnimationFrame(draw)
		return () => {
			cancelAnimationFrame(raf)
			ro.disconnect()
		}
	}, [store, registry, reducedMotion])

	return (
		<canvas
			ref={canvasRef}
			className="pointer-events-none absolute inset-0 h-full w-full"
			style={{ zIndex: 4 }}
		/>
	)
}
