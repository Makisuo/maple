import { createContext, useContext, useRef } from "react"
import { useStoreApi } from "@xyflow/react"
import { useMediaQuery } from "@maple/ui/hooks/use-media-query"
import { useMountEffect } from "@/hooks/use-mount-effect"

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
	/** Changes only when published edge geometry or traffic changes. */
	readonly revision: number
	set: (id: string, spec: EdgeParticleSpec) => void
	remove: (id: string) => void
}

export function createParticleRegistry(): ParticleRegistry {
	const map = new Map<string, EdgeParticleSpec>()
	let revision = 0
	return {
		map,
		get revision() {
			return revision
		},
		set: (id, spec) => {
			const current = map.get(id)
			if (
				current?.pathString === spec.pathString &&
				current.sourceColor === spec.sourceColor &&
				current.callsPerSecond === spec.callsPerSecond &&
				current.strokeWidth === spec.strokeWidth
			) {
				return
			}
			map.set(id, spec)
			revision++
		},
		remove: (id) => {
			if (map.delete(id)) revision++
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

const SVG_NS = "http://www.w3.org/2000/svg"

interface CachedPath {
	/** Equal-distance samples along the SVG path: [x0, y0, x1, y1, ...]. */
	points: Float32Array
	segments: number
	minX: number
	minY: number
	maxX: number
	maxY: number
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
		if (length <= 0) return null

		// SVGPathElement#getPointAtLength is relatively expensive. Sample it only
		// when edge geometry changes, then linearly interpolate this compact lookup
		// table in the rAF loop. Equal-distance samples retain constant particle speed.
		const segments = Math.min(64, Math.max(16, Math.ceil(length / 24)))
		const points = new Float32Array((segments + 1) * 2)
		let minX = Number.POSITIVE_INFINITY
		let minY = Number.POSITIVE_INFINITY
		let maxX = Number.NEGATIVE_INFINITY
		let maxY = Number.NEGATIVE_INFINITY
		for (let index = 0; index <= segments; index++) {
			const point = el.getPointAtLength((index / segments) * length)
			points[index * 2] = point.x
			points[index * 2 + 1] = point.y
			minX = Math.min(minX, point.x)
			minY = Math.min(minY, point.y)
			maxX = Math.max(maxX, point.x)
			maxY = Math.max(maxY, point.y)
		}
		entry = { points, segments, minX, minY, maxX, maxY }
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

interface CompiledParticleTrack extends CachedPath {
	count: number
	duration: number
	phase: number
	radius: number
	sourceColor: string
}

function compileParticleTracks(
	registry: ParticleRegistry,
	pathCache: Map<string, CachedPath>,
): CompiledParticleTrack[] {
	const budget = allocateParticleBudget(registry.map)
	const tracks: CompiledParticleTrack[] = []
	const livePaths = new Set<string>()

	for (const [id, spec] of registry.map) {
		livePaths.add(spec.pathString)
		const count = budget.get(id) ?? 0
		if (count <= 0 || !spec.pathString) continue
		const path = getCachedPath(pathCache, spec.pathString)
		if (!path) continue
		tracks.push({
			...path,
			count,
			duration: traversalDuration(spec.callsPerSecond),
			phase: hash01(id),
			radius: Math.max(1.5, spec.strokeWidth * 0.5),
			sourceColor: spec.sourceColor,
		})
	}

	// Geometry changes after layout / drag. Keep only paths the registry can still
	// publish so repeated layouts do not grow this cache for the lifetime of the map.
	for (const key of pathCache.keys()) if (!livePaths.has(key)) pathCache.delete(key)
	return tracks
}

/**
 * The single canvas overlay. Must render inside `<ReactFlow>` so it can read the
 * live viewport transform from the flow store. Reads the geometry registry every
 * frame — no React re-render in the animation loop.
 */
function AnimatedParticleCanvas({ registry }: { registry: ParticleRegistry }) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null)
	const store = useStoreApi()

	useMountEffect(() => {
		const canvas = canvasRef.current
		if (!canvas) return
		const ctx = canvas.getContext("2d")
		if (!ctx) return

		const pathCache = new Map<string, CachedPath>()
		let raf = 0
		let cssW = 0
		let cssH = 0
		let dpr = 1
		let compiledRevision = -1
		let tracks: CompiledParticleTrack[] = []
		// Reused every frame so particle animation produces no garbage for the GC.
		const frameX = new Float32Array(MAX_TOTAL_PARTICLES)
		const frameY = new Float32Array(MAX_TOTAL_PARTICLES)
		const frameRadius = new Float32Array(MAX_TOTAL_PARTICLES)

		const resize = () => {
			// Higher ratios multiply the full-screen clear cost without improving these
			// tiny, soft particles. 2x remains Retina-sharp and bounds mobile GPU work.
			dpr = Math.min(2, window.devicePixelRatio || 1)
			cssW = canvas.clientWidth
			cssH = canvas.clientHeight
			const width = Math.max(1, Math.round(cssW * dpr))
			const height = Math.max(1, Math.round(cssH * dpr))
			if (canvas.width !== width) canvas.width = width
			if (canvas.height !== height) canvas.height = height
		}
		resize()
		const ro = new ResizeObserver(resize)
		ro.observe(canvas)

		const draw = (nowMs: number) => {
			raf = requestAnimationFrame(draw)
			// Clear in device space.
			ctx.setTransform(1, 0, 0, 1, 0, 0)
			ctx.clearRect(0, 0, canvas.width, canvas.height)

			if (compiledRevision !== registry.revision) {
				tracks = compileParticleTracks(registry, pathCache)
				compiledRevision = registry.revision
			}
			if (tracks.length === 0) return

			const [tx, ty, zoom] = store.getState().transform
			// Flow→device transform (combines viewport transform + DPR).
			ctx.setTransform(zoom * dpr, 0, 0, zoom * dpr, tx * dpr, ty * dpr)

			// Visible flow-space rect (for culling), with a margin.
			const margin = 40
			const viewLeft = -tx / zoom - margin
			const viewTop = -ty / zoom - margin
			const viewRight = viewLeft + cssW / zoom + margin * 2
			const viewBottom = viewTop + cssH / zoom + margin * 2

			const t = nowMs / 1000
			let frameCount = 0

			for (const track of tracks) {
				// Reject a whole offscreen edge before sampling any of its particles.
				if (
					track.maxX < viewLeft ||
					track.minX > viewRight ||
					track.maxY < viewTop ||
					track.minY > viewBottom
				) {
					continue
				}

				const base = (t / track.duration + track.phase) % 1
				ctx.globalAlpha = 0.2
				ctx.fillStyle = track.sourceColor
				ctx.beginPath()
				let visibleOnTrack = 0

				for (let index = 0; index < track.count; index++) {
					let frac = base + index / track.count
					frac -= Math.floor(frac)
					const scaled = frac * track.segments
					const pointIndex = Math.min(track.segments - 1, Math.floor(scaled))
					const mix = scaled - pointIndex
					const offset = pointIndex * 2
					const nextOffset = offset + 2
					const x = track.points[offset] + (track.points[nextOffset] - track.points[offset]) * mix
					const y =
						track.points[offset + 1] +
						(track.points[nextOffset + 1] - track.points[offset + 1]) * mix
					if (x < viewLeft || x > viewRight || y < viewTop || y > viewBottom) {
						continue
					}
					ctx.moveTo(x + track.radius * 2.6, y)
					ctx.arc(x, y, track.radius * 2.6, 0, Math.PI * 2)
					frameX[frameCount] = x
					frameY[frameCount] = y
					frameRadius[frameCount] = track.radius
					frameCount++
					visibleOnTrack++
				}
				if (visibleOnTrack > 0) ctx.fill()
			}

			// Every core has the same color, so paint all of them in one canvas fill.
			if (frameCount > 0) {
				ctx.globalAlpha = 0.95
				ctx.fillStyle = "#ffffff"
				ctx.beginPath()
				for (let index = 0; index < frameCount; index++) {
					const radius = frameRadius[index] * 0.75
					ctx.moveTo(frameX[index] + radius, frameY[index])
					ctx.arc(frameX[index], frameY[index], radius, 0, Math.PI * 2)
				}
				ctx.fill()
			}
			ctx.globalAlpha = 1
		}

		raf = requestAnimationFrame(draw)
		return () => {
			cancelAnimationFrame(raf)
			ro.disconnect()
		}
	})

	return (
		<canvas
			ref={canvasRef}
			className="pointer-events-none absolute inset-0 h-full w-full"
			style={{ zIndex: 4 }}
		/>
	)
}

export function ServiceMapParticleCanvas() {
	const registry = useParticleRegistry()
	const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)")

	// Conditional mounting restarts the external canvas synchronization if the OS
	// motion preference changes, without dependency-driven effect choreography.
	if (reducedMotion || !registry) return null
	return <AnimatedParticleCanvas registry={registry} />
}
