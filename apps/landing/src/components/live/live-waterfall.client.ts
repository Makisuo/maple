/**
 * Drives the LiveWaterfall animation with Motion v12. Cycle structure:
 *
 *   PLAY  (totalMs * speed)    — bars grow in sequence at 1/speed wall-speed.
 *   PAUSE (1400ms)             — all bars full; slowest-span annotation reveals.
 *   RESET (320ms)              — frame opacity fades to 0.35 (CSS transition);
 *                                bars snap back to scaleX(0); opacity returns to 1.
 *
 * Each bar is its own Motion `animate()` call with explicit delay/duration
 * matching its real wall-time window. `.is-active` is bound to each bar's
 * lifecycle (timer at start, .finished at end) so multi-active is automatic
 * and there's no per-frame index race.
 *
 * The cursor is one Motion `animate()` driving the `x` transform component, so
 * it rides the compositor — no layout work per frame.
 *
 * Uses Motion's individual transform properties (scaleX, x), not the `transform`
 * shorthand string keyframes — Motion can't interpolate opaque transform strings.
 */
import { animate, type AnimationPlaybackControls } from "motion"

const PAUSE_MS = 1400
const RESET_MS = 320
const DEFAULT_SPEED_DIVISOR = 10

type Row = {
	row: HTMLElement
	bar: HTMLElement
	startMs: number
	durationMs: number
}

const ATTACHED = new WeakSet<HTMLElement>()

export function startWaterfall(root: HTMLElement) {
	if (ATTACHED.has(root)) return
	ATTACHED.add(root)

	const totalMs = Number(root.dataset.total ?? 200)
	const speedDivisor = Number(root.dataset.speed ?? DEFAULT_SPEED_DIVISOR)
	const stage = root.querySelector<HTMLElement>("[data-waterfall-stage]") ?? root
	const cursor = root.querySelector<HTMLElement>("[data-trace-cursor]")
	const firstTrack = root.querySelector<HTMLElement>(".span-bar-track")

	const rows: Row[] = Array.from(root.querySelectorAll<HTMLElement>(".waterfall-row")).map((row) => {
		const bar = row.querySelector<HTMLElement>(".span-bar")!
		const leftPct = parsePct(bar.style.left)
		const widthPct = parsePct(bar.style.width)
		return {
			row,
			bar,
			startMs: (leftPct / 100) * totalMs,
			durationMs: (widthPct / 100) * totalMs,
		}
	})
	if (rows.length === 0) return

	const slowestIdx = rows.reduce(
		(best, r, i, all) => (r.durationMs > all[best].durationMs ? i : best),
		0,
	)

	let trackOffsetX = 0
	let trackWidth = 0
	const measureTrack = () => {
		if (!firstTrack) return
		const sR = stage.getBoundingClientRect()
		const tR = firstTrack.getBoundingClientRect()
		trackOffsetX = tR.left - sR.left
		trackWidth = tR.width
	}
	measureTrack()
	const ro = new ResizeObserver(measureTrack)
	ro.observe(stage)

	// Generation token: each cycle() invocation gets a unique id; stale callbacks
	// (timers scheduled by an older generation) check against `gen` and bail out.
	let gen = 0
	let inflight: AnimationPlaybackControls[] = []
	let phaseTimers: number[] = []

	const stopInflight = () => {
		inflight.forEach((a) => {
			try { a.stop() } catch {}
		})
		inflight = []
	}

	const clearPhaseTimers = () => {
		phaseTimers.forEach((t) => window.clearTimeout(t))
		phaseTimers = []
	}

	const armRows = () => {
		rows.forEach((r) => {
			r.bar.style.transform = "scaleX(0)"
			r.row.classList.remove("is-active", "is-slowest")
		})
		if (cursor) {
			cursor.style.transform = `translate3d(${trackOffsetX}px, 0, 0)`
			cursor.style.setProperty("--cursor-opacity", "0")
		}
		stage.style.setProperty("--frame-opacity", "1")
	}

	const playOnce = (myGen: number) => {
		const playSec = (totalMs * speedDivisor) / 1000

		const barAnims: AnimationPlaybackControls[] = []
		rows.forEach((r, idx) => {
			const startSec = (r.startMs * speedDivisor) / 1000
			const durSec = Math.max(0.01, (r.durationMs * speedDivisor) / 1000)

			window.setTimeout(() => {
				if (gen === myGen) r.row.classList.add("is-active")
			}, startSec * 1000)

			try {
				const a = animate(
					r.bar,
					{ scaleX: [0, 1] },
					{ duration: durSec, delay: startSec, ease: "linear" },
				)
				console.log("[wf] bar", idx, "animate ok", { durSec, startSec, hasFinished: !!a.finished })
				a.finished
					.then(() => {
						if (gen === myGen) r.row.classList.remove("is-active")
					})
					.catch((e) => {
						console.warn("[wf] bar finished rejected", idx, e)
					})
				barAnims.push(a)
			} catch (e) {
				console.error("[wf] bar animate threw", idx, e)
			}
		})

		let cursorAnim: AnimationPlaybackControls | null = null
		if (cursor) {
			cursor.style.setProperty("--cursor-opacity", "1")
			try {
				cursorAnim = animate(
					cursor,
					{ x: [trackOffsetX, trackOffsetX + trackWidth] },
					{ duration: playSec, ease: "linear" },
				)
				console.log("[wf] cursor animate ok", { playSec, from: trackOffsetX, to: trackOffsetX + trackWidth })
			} catch (e) {
				console.error("[wf] cursor animate threw", e)
			}
		}

		inflight = cursorAnim ? [...barAnims, cursorAnim] : barAnims
		return Promise.all(inflight.map((a) => a.finished)).catch(() => {})
	}

	const phaseDelay = (ms: number) =>
		new Promise<void>((resolve) => {
			const t = window.setTimeout(() => resolve(), ms)
			phaseTimers.push(t)
		})

	const cycle = async () => {
		const myGen = ++gen
		while (gen === myGen) {
			armRows()
			await playOnce(myGen)
			if (gen !== myGen) return

			rows[slowestIdx].row.classList.add("is-slowest")
			await phaseDelay(PAUSE_MS)
			if (gen !== myGen) return
			rows[slowestIdx].row.classList.remove("is-slowest")

			stage.style.setProperty("--frame-opacity", "0.35")
			if (cursor) cursor.style.setProperty("--cursor-opacity", "0")
			await phaseDelay(RESET_MS)
		}
	}

	cycle()
}

function parsePct(value: string): number {
	const n = parseFloat(value)
	return Number.isFinite(n) ? n : 0
}
