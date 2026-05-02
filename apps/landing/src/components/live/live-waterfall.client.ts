/**
 * Drives the LiveWaterfall animation: spans grow in sequence based on their
 * declared startMs/durationMs (encoded in the SSR'd inline `left` and `width`
 * styles), the active span lights amber, then the loop restarts.
 *
 * Vanilla rAF, no framework. Animates only `transform` (scale on the inner
 * bar) — no layout properties, per shared design law.
 */

type RowState = {
	row: HTMLElement;
	bar: HTMLElement;
	name: HTMLElement;
	startMs: number;
	durationMs: number;
};

const PAUSE_MS = 1100;

export function startWaterfall(root: HTMLElement) {
	const totalMs = Number(root.dataset.total ?? 200);
	const rows: RowState[] = Array.from(
		root.querySelectorAll<HTMLElement>(".waterfall-row"),
	).map((row) => {
		const bar = row.querySelector<HTMLElement>(".span-bar")!;
		const name = row.querySelector<HTMLElement>(".span-name")!;
		const leftPct = parsePct(bar.style.left);
		const widthPct = parsePct(bar.style.width);
		return {
			row,
			bar,
			name,
			startMs: (leftPct / 100) * totalMs,
			durationMs: (widthPct / 100) * totalMs,
		};
	});

	if (rows.length === 0) return;

	let raf = 0;
	let cycleStart = performance.now();

	const tick = (now: number) => {
		const elapsed = now - cycleStart;
		const cycleMs = totalMs * 6 + PAUSE_MS;

		if (elapsed > cycleMs) {
			cycleStart = now;
			rows.forEach((r) => {
				r.bar.style.setProperty("--bar-progress", "0");
				r.name.classList.remove("is-active");
				r.bar.classList.remove("is-active");
			});
			raf = requestAnimationFrame(tick);
			return;
		}

		const playMs = Math.min(elapsed, totalMs * 6) / 6;

		let activeIdx = -1;
		rows.forEach((r, i) => {
			const localElapsed = playMs - r.startMs;
			const progress = clamp(localElapsed / r.durationMs, 0, 1);
			r.bar.style.setProperty("--bar-progress", String(progress));
			if (progress > 0 && progress < 1) activeIdx = i;
		});

		rows.forEach((r, i) => {
			const isActive = i === activeIdx;
			r.name.classList.toggle("is-active", isActive);
			r.bar.classList.toggle("is-active", isActive);
		});

		raf = requestAnimationFrame(tick);
	};

	raf = requestAnimationFrame(tick);

	// Stop when out of viewport to save battery.
	const io = new IntersectionObserver(([entry]) => {
		if (!entry.isIntersecting) {
			cancelAnimationFrame(raf);
		} else {
			cycleStart = performance.now();
			raf = requestAnimationFrame(tick);
		}
	}, { rootMargin: "40px" });
	io.observe(root);
}

function parsePct(value: string): number {
	const n = parseFloat(value);
	return Number.isFinite(n) ? n : 0;
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}
