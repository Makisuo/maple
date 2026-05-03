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
 * The cursor is one Motion `animate()` driving `transform: translate3d(...)`,
 * so it rides the compositor — no layout work per frame.
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

export function startWaterfall(root: HTMLElement) {
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

	let inflight: AnimationPlaybackControls[] = []
	let timers: number[] = []
	let cancelled = false

	const stopAll = () => {
		inflight.forEach((a) => a.stop())
		inflight = []
		timers.forEach((t) => window.clearTimeout(t))
		timers = []
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

	const playOnce = () => {
		const playSec = (totalMs * speedDivisor) / 1000

		const barAnims = rows.map((r) => {
			const startSec = (r.startMs * speedDivisor) / 1000
			const durSec = (r.durationMs * speedDivisor) / 1000

			const startTimer = window.setTimeout(() => {
				if (!cancelled) r.row.classList.add("is-active")
			}, startSec * 1000)
			timers.push(startTimer)

			const a = animate(
				r.bar,
				{ transform: ["scaleX(0)", "scaleX(1)"] },
				{ duration: durSec, delay: startSec, ease: "linear" },
			)
			a.finished
				.then(() => {
					if (!cancelled) r.row.classList.remove("is-active")
				})
				.catch(() => {})
			return a
		})

		let cursorAnim: AnimationPlaybackControls | null = null
		if (cursor) {
			cursor.style.setProperty("--cursor-opacity", "1")
			cursorAnim = animate(
				cursor,
				{
					transform: [
						`translate3d(${trackOffsetX}px, 0, 0)`,
						`translate3d(${trackOffsetX + trackWidth}px, 0, 0)`,
					],
				},
				{ duration: playSec, ease: "linear" },
			)
		}

		inflight = cursorAnim ? [...barAnims, cursorAnim] : barAnims
		return Promise.all(inflight.map((a) => a.finished)).catch(() => {})
	}

	const delay = (ms: number) =>
		new Promise<void>((resolve) => {
			const t = window.setTimeout(() => resolve(), ms)
			timers.push(t)
		})

	const cycle = async () => {
		while (!cancelled) {
			armRows()
			await playOnce()
			if (cancelled) return

			rows[slowestIdx].row.classList.add("is-slowest")
			await delay(PAUSE_MS)
			if (cancelled) return
			rows[slowestIdx].row.classList.remove("is-slowest")

			stage.style.setProperty("--frame-opacity", "0.35")
			if (cursor) cursor.style.setProperty("--cursor-opacity", "0")
			await delay(RESET_MS)
		}
	}

	cycle()

	const io = new IntersectionObserver(
		([entry]) => {
			if (!entry.isIntersecting) {
				cancelled = true
				stopAll()
			} else if (cancelled) {
				cancelled = false
				cycle()
			}
		},
		{ rootMargin: "40px" },
	)
	io.observe(root)
}

function parsePct(value: string): number {
	const n = parseFloat(value)
	return Number.isFinite(n) ? n : 0
}
