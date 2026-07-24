/**
 * Drives the `maple start` reveal:
 *   - hide every line,
 *   - type the command,
 *   - hold for a beat while the server "binds",
 *   - reveal the banner segments in the order the CLI prints them,
 *   - stop.
 *
 * Unlike the MCP transcript this does NOT loop: it fires once, the first time
 * the frame is meaningfully on screen, then disconnects. `maple start` starts
 * once and then just runs; a rewinding terminal would say the opposite.
 */

/** The homepage's one easing curve — same as HeroCarousel and the MCP transcript. */
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)"
const REVEAL_MS = 420
/** Lines inside one segment cascade rather than popping together. */
const LINE_STAGGER_MS = 70
/** Text resolves out of focus, the way a terminal line commits. */
const REVEAL_BLUR_PX = 5
const TYPE_CPS = 30
/** The pause between the typed command and `● listening` — the bind. */
const BOOT_MS = 460
/** Gap between banner segments once the server is up. */
const SEG_INTERVAL_MS = 340

export function playLocalTerminal(root: HTMLElement) {
	const segments = groupBySegment(root)
	const typedEl = root.querySelector<HTMLElement>("[data-typed]")
	const command = typedEl?.dataset.typed ?? ""

	const hideAll = () => {
		for (const el of root.querySelectorAll<HTMLElement>(".lt-line")) {
			el.style.transition = "none"
			el.style.transitionDelay = "0ms"
			el.style.opacity = "0"
			el.style.transform = "translateY(4px)"
			el.style.filter = `blur(${REVEAL_BLUR_PX}px)`
		}
		if (typedEl) typedEl.textContent = ""
	}

	const revealSegment = (idx: number) => {
		const items = segments[idx] ?? []
		items.forEach((el, i) => {
			el.style.transition = [
				`opacity ${REVEAL_MS}ms ${EASE}`,
				`transform ${REVEAL_MS}ms ${EASE}`,
				`filter ${REVEAL_MS}ms ${EASE}`,
			].join(", ")
			el.style.transitionDelay = `${i * LINE_STAGGER_MS}ms`
			el.style.opacity = "1"
			el.style.transform = "translateY(0)"
			// Dropped back to `none` on transitionend so a settled banner isn't
			// holding a filter layer per line for the rest of the session.
			el.style.filter = "blur(0px)"
		})
	}

	// One delegated listener rather than one per line.
	root.addEventListener("transitionend", (event) => {
		const el = event.target as HTMLElement
		if (event.propertyName === "filter" && el.style.filter === "blur(0px)") el.style.filter = "none"
	})

	const typeText = (el: HTMLElement, text: string) =>
		new Promise<void>((resolve) => {
			let i = 0
			const total = text.length
			const stepMs = 1000 / TYPE_CPS
			let last = performance.now()
			const tick = (now: number) => {
				if (now - last >= stepMs) {
					i = Math.min(total, i + Math.max(1, Math.round((now - last) / stepMs)))
					el.textContent = text.slice(0, i)
					last = now
				}
				if (i < total) requestAnimationFrame(tick)
				else resolve()
			}
			requestAnimationFrame(tick)
		})

	const sleep = (ms: number) =>
		new Promise<void>((resolve) => {
			const start = performance.now()
			const tick = (now: number) => {
				if (now - start >= ms) return resolve()
				requestAnimationFrame(tick)
			}
			requestAnimationFrame(tick)
		})

	const run = async () => {
		revealSegment(0)
		if (typedEl) {
			await sleep(160)
			await typeText(typedEl, command)
		}
		await sleep(BOOT_MS)

		for (let i = 1; i < segments.length; i++) {
			revealSegment(i)
			await sleep(SEG_INTERVAL_MS + (segments[i]?.length ?? 1) * LINE_STAGGER_MS)
		}
	}

	hideAll()

	// Fires once. A frame that replayed on every scroll-by would read as a
	// server restarting, which is the opposite of the claim.
	const io = new IntersectionObserver(
		([entry], observer) => {
			if (!entry?.isIntersecting) return
			observer.disconnect()
			run()
		},
		{ threshold: 0.35 },
	)
	io.observe(root)
}

function groupBySegment(root: HTMLElement): HTMLElement[][] {
	const out: HTMLElement[][] = []
	for (const el of root.querySelectorAll<HTMLElement>(".lt-line")) {
		const idx = Number(el.dataset.segment ?? 0)
		if (!out[idx]) out[idx] = []
		out[idx].push(el)
	}
	return out
}
