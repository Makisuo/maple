/**
 * Drives the LiveWaterfall animation. Cycle structure:
 *
 *   PLAY  (totalMs * speed)    — bars grow in sequence at 1/speed wall-speed.
 *   PAUSE (1400ms)             — all bars full; slowest-span annotation reveals.
 *   RESET (320ms)              — frame opacity fades to 0.35 (CSS transition);
 *                                progress snaps to 0; opacity returns to 1.
 *
 * The cursor (.trace-cursor) is driven by the same `playMs` and rests at 0
 * during pause/reset. The slowest row gets `.is-slowest` only during the pause
 * (so its CSS animation re-fires every cycle).
 *
 * Vanilla rAF, no framework. Animates only `transform` (scale) and CSS custom
 * properties — no layout-property animation, per shared design law.
 */

type RowState = {
	row: HTMLElement;
	bar: HTMLElement;
	name: HTMLElement;
	dur: HTMLElement | null;
	startMs: number;
	durationMs: number;
};

const PAUSE_MS = 1400;
const RESET_MS = 320;
const DEFAULT_SPEED_DIVISOR = 10;

export function startWaterfall(root: HTMLElement) {
	const totalMs = Number(root.dataset.total ?? 200);
	const speedDivisor = Number(root.dataset.speed ?? DEFAULT_SPEED_DIVISOR);
	const stage = root.querySelector<HTMLElement>("[data-waterfall-stage]") ?? root;
	const cursor = root.querySelector<HTMLElement>("[data-trace-cursor]");
	const firstTrack = root.querySelector<HTMLElement>(".span-bar-track");

	const rows: RowState[] = Array.from(
		root.querySelectorAll<HTMLElement>(".waterfall-row"),
	).map((row) => {
		const bar = row.querySelector<HTMLElement>(".span-bar")!;
		const name = row.querySelector<HTMLElement>(".span-name")!;
		const dur = row.querySelector<HTMLElement>(".span-dur");
		const leftPct = parsePct(bar.style.left);
		const widthPct = parsePct(bar.style.width);
		return {
			row,
			bar,
			name,
			dur,
			startMs: (leftPct / 100) * totalMs,
			durationMs: (widthPct / 100) * totalMs,
		};
	});

	if (rows.length === 0) return;

	const slowestIdx = rows.reduce(
		(best, r, i, all) => (r.durationMs > all[best].durationMs ? i : best),
		0,
	);

	const playEndMs = totalMs * speedDivisor;
	const pauseEndMs = playEndMs + PAUSE_MS;
	const cycleEndMs = pauseEndMs + RESET_MS;

	let trackOffsetX = 0;
	let trackWidth = 0;
	const measureTrack = () => {
		if (!firstTrack) return;
		const sR = stage.getBoundingClientRect();
		const tR = firstTrack.getBoundingClientRect();
		trackOffsetX = tR.left - sR.left;
		trackWidth = tR.width;
	};
	measureTrack();
	const ro = new ResizeObserver(measureTrack);
	ro.observe(stage);

	let raf = 0;
	let cycleStart = performance.now();
	let resetArmed = false;
	let pauseArmed = false;

	const setActive = (idx: number) => {
		rows.forEach((r, i) => {
			const isActive = i === idx;
			r.name.classList.toggle("is-active", isActive);
			r.bar.classList.toggle("is-active", isActive);
			r.dur?.classList.toggle("is-active", isActive);
		});
	};

	const setSlowest = (on: boolean) => {
		rows.forEach((r, i) => r.row.classList.toggle("is-slowest", on && i === slowestIdx));
	};

	const setCursor = (xPct: number, opacity: number) => {
		if (!cursor) return;
		const px = trackOffsetX + (xPct / 100) * trackWidth;
		cursor.style.setProperty("--cursor-x", `${px}px`);
		cursor.style.setProperty("--cursor-opacity", String(opacity));
	};

	const armCycle = () => {
		// Snap progress back to 0 instantly. The visible fade is on the parent
		// stage's opacity (CSS transition), so individual bars don't pop.
		rows.forEach((r) => r.bar.style.setProperty("--bar-progress", "0"));
		setActive(-1);
		setSlowest(false);
		setCursor(0, 0);
		// Restore stage opacity for the next play.
		stage.style.setProperty("--frame-opacity", "1");
		resetArmed = false;
		pauseArmed = false;
	};

	const tick = (now: number) => {
		const elapsed = now - cycleStart;

		if (elapsed >= cycleEndMs) {
			cycleStart = now;
			armCycle();
			raf = requestAnimationFrame(tick);
			return;
		}

		if (elapsed >= pauseEndMs) {
			// RESET window: trigger fade-to-0.35 once, then keep running until cycle end.
			if (!resetArmed) {
				stage.style.setProperty("--frame-opacity", "0.35");
				setCursor(100, 0);
				resetArmed = true;
			}
			raf = requestAnimationFrame(tick);
			return;
		}

		if (elapsed >= playEndMs) {
			// PAUSE window: bars full, cursor parked at end, slowest annotation showing.
			if (!pauseArmed) {
				rows.forEach((r) => r.bar.style.setProperty("--bar-progress", "1"));
				setActive(-1);
				setSlowest(true);
				setCursor(100, 0);
				pauseArmed = true;
			}
			raf = requestAnimationFrame(tick);
			return;
		}

		// PLAY window.
		const playMs = elapsed / speedDivisor;
		let activeIdx = -1;
		rows.forEach((r, i) => {
			const localElapsed = playMs - r.startMs;
			const progress = clamp(localElapsed / r.durationMs, 0, 1);
			r.bar.style.setProperty("--bar-progress", String(progress));
			if (progress > 0 && progress < 1) activeIdx = i;
		});
		setActive(activeIdx);
		setCursor((playMs / totalMs) * 100, 1);

		raf = requestAnimationFrame(tick);
	};

	armCycle();
	raf = requestAnimationFrame(tick);

	// Stop when out of viewport to save battery.
	const io = new IntersectionObserver(
		([entry]) => {
			if (!entry.isIntersecting) {
				cancelAnimationFrame(raf);
			} else {
				cycleStart = performance.now();
				armCycle();
				raf = requestAnimationFrame(tick);
			}
		},
		{ rootMargin: "40px" },
	);
	io.observe(root);
}

function parsePct(value: string): number {
	const n = parseFloat(value);
	return Number.isFinite(n) ? n : 0;
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}
