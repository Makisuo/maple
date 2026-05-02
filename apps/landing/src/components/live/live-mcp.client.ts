/**
 * Drives the MCP transcript reveal:
 *   - hide all segments,
 *   - reveal segment 0, type the agent's prompt character-by-character,
 *   - then reveal segments 1..N at staggered intervals,
 *   - pause, reset, loop.
 *
 * Pauses when the element scrolls out of view (IntersectionObserver).
 */

const SEG_INTERVAL_MS = 1100;   // gap between non-typed segments
const TYPE_CPS = 38;            // characters per second for the typed line
const HOLD_MS = 6500;           // dwell on the finished transcript before reset
const RESET_FADE_MS = 280;

export function playMcp(root: HTMLElement) {
	const segments = groupBySegment(root);
	const typedEl = root.querySelector<HTMLElement>("[data-typed]");
	const totalSegments = segments.length;

	let cancelled = false;
	let inView = true;

	const hideAll = () => {
		root.querySelectorAll<HTMLElement>(".mcp-line").forEach((el) => {
			el.style.opacity = "0";
			el.style.transform = "translateY(2px)";
			el.style.transition = "none";
		});
		if (typedEl) typedEl.textContent = "";
	};

	const revealSegment = (idx: number) => {
		const items = segments[idx] ?? [];
		items.forEach((el) => {
			el.style.transition = "opacity 220ms ease, transform 220ms ease";
			el.style.opacity = "1";
			el.style.transform = "translateY(0)";
		});
	};

	const typeText = (el: HTMLElement, text: string) =>
		new Promise<void>((resolve) => {
			let i = 0;
			const total = text.length;
			const stepMs = 1000 / TYPE_CPS;
			let last = performance.now();
			const tick = (now: number) => {
				if (cancelled) return resolve();
				if (now - last >= stepMs) {
					i = Math.min(total, i + Math.max(1, Math.round((now - last) / stepMs)));
					el.textContent = text.slice(0, i);
					last = now;
				}
				if (i < total) {
					requestAnimationFrame(tick);
				} else {
					resolve();
				}
			};
			requestAnimationFrame(tick);
		});

	const sleep = (ms: number) =>
		new Promise<void>((resolve) => {
			const start = performance.now();
			const tick = (now: number) => {
				if (cancelled) return resolve();
				if (now - start >= ms) return resolve();
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		});

	const waitForVisible = async () => {
		while (!inView && !cancelled) await sleep(220);
	};

	const run = async () => {
		while (!cancelled) {
			await waitForVisible();
			hideAll();
			await sleep(RESET_FADE_MS);

			for (let i = 0; i < totalSegments; i++) {
				if (cancelled) return;
				await waitForVisible();
				revealSegment(i);
				if (i === 0 && typedEl) {
					await sleep(140);
					await typeText(typedEl, typedEl.dataset.typed ?? "");
				}
				await sleep(SEG_INTERVAL_MS);
			}
			await sleep(HOLD_MS);
		}
	};

	const io = new IntersectionObserver(([entry]) => {
		inView = entry.isIntersecting;
	}, { rootMargin: "60px" });
	io.observe(root);

	hideAll();
	run();
}

function groupBySegment(root: HTMLElement): HTMLElement[][] {
	const out: HTMLElement[][] = [];
	root.querySelectorAll<HTMLElement>(".mcp-line").forEach((el) => {
		const idx = Number(el.dataset.segment ?? 0);
		if (!out[idx]) out[idx] = [];
		out[idx].push(el);
	});
	return out;
}
