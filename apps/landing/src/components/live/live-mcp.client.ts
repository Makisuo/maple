/**
 * Drives the MCP transcript as a session being typed rather than a list fading
 * in. Three line kinds, marked in the markup with `data-type`:
 *
 *   prompt  — a human at a keyboard. Types at reading speed, caret trailing.
 *   call    — the agent emitting a tool call. Types ~3× faster; it is a machine
 *             writing, but it is still writing, so it shouldn't just appear.
 *   result  — everything else. A server response is not typed, it *lands*: one
 *             latency beat of nothing, then the whole block resolves out of a
 *             blur at once. That contrast is what sells the other two as typing.
 *
 * One caret element roves to whichever line is being typed, so there is always
 * exactly one on screen; the static caret in the last segment takes over at the
 * end of the run.
 *
 * Typing walks the line's text nodes in order, so a line built from coloured
 * spans (`→ find_errors` + muted args) types straight through the markup
 * without it having to be flattened into a string.
 *
 * Everything sleeps on rAF, so the loop pauses with the tab and the
 * IntersectionObserver keeps it from running off-screen. Skipped entirely under
 * prefers-reduced-motion — the SSR'd transcript is the static fallback, which is
 * also why the original text is cached before the first blank.
 */

const PROMPT_CPS = 34 // a person typing
const CALL_CPS = 96 // the agent writing a call
const RESULT_LATENCY_MS = 420 // round trip before a response lands
const RESULT_REVEAL_MS = 380
const RESULT_STAGGER_MS = 70 // rows of one response resolve in sequence
const THINK_MS = 520 // beat between a finished line and the next one
const READ_MS = 700 // longer beat after a result, to read it
const HOLD_MS = 6500 // dwell on the finished transcript before reset
const RESET_FADE_MS = 280

/** The homepage's one easing curve — same as HeroCarousel and the scrollstory. */
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)"
/** Responses resolve out of focus; typed lines never blur, they type. */
const REVEAL_BLUR_PX = 5

type Chunk = { node: Text; full: string }

export function playMcp(root: HTMLElement) {
	// Second init on the same root would cache the *blanked* text as the
	// original and leave a transcript that types nothing — silently, since the
	// lines still reveal. Cheap to make impossible.
	if (root.dataset.mcpPlaying) return
	root.dataset.mcpPlaying = "1"

	const lines = Array.from(root.querySelectorAll<HTMLElement>(".mcp-line"))
	// Captured before anything is blanked — this is the SSR text, and it is the
	// only copy once typing starts.
	const chunks = new Map<HTMLElement, Chunk[]>()
	for (const line of lines) {
		if (line.dataset.type) chunks.set(line, textChunks(line))
	}

	const caret = document.createElement("span")
	caret.className = "mcp-caret"

	let cancelled = false
	let inView = true

	const sleep = (ms: number) =>
		new Promise<void>((resolve) => {
			const start = performance.now()
			const tick = (now: number) => {
				if (cancelled) return resolve()
				if (now - start >= ms) return resolve()
				requestAnimationFrame(tick)
			}
			requestAnimationFrame(tick)
		})

	const waitForVisible = async () => {
		while (!inView && !cancelled) await sleep(220)
	}

	const hideAll = () => {
		caret.remove()
		for (const line of lines) {
			line.style.transition = "none"
			line.style.transitionDelay = "0ms"
			line.style.opacity = "0"
			line.style.transform = "translateY(4px)"
			line.style.filter = `blur(${REVEAL_BLUR_PX}px)`
			for (const chunk of chunks.get(line) ?? []) chunk.node.data = ""
		}
	}

	/** A typed line's box is already there; only its text is missing. */
	const showBox = (line: HTMLElement) => {
		line.style.transition = "none"
		line.style.transitionDelay = "0ms"
		line.style.opacity = "1"
		line.style.transform = "none"
		line.style.filter = "none"
	}

	const landResult = (line: HTMLElement, index: number) => {
		line.style.transition = [
			`opacity ${RESULT_REVEAL_MS}ms ${EASE}`,
			`transform ${RESULT_REVEAL_MS}ms ${EASE}`,
			`filter ${RESULT_REVEAL_MS}ms ${EASE}`,
		].join(", ")
		line.style.transitionDelay = `${index * RESULT_STAGGER_MS}ms`
		line.style.opacity = "1"
		line.style.transform = "translateY(0)"
		// Dropped to `none` on transitionend so a settled transcript isn't
		// holding a filter layer per line through the whole dwell.
		line.style.filter = "blur(0px)"
	}

	root.addEventListener("transitionend", (event) => {
		const el = event.target as HTMLElement
		if (event.propertyName === "filter" && el.style.filter === "blur(0px)") el.style.filter = "none"
	})

	const typeLine = (line: HTMLElement, cps: number) =>
		new Promise<void>((resolve) => {
			const parts = chunks.get(line) ?? []
			line.appendChild(caret)
			const stepMs = 1000 / cps
			let part = 0
			let typed = 0
			let last = performance.now()

			const tick = (now: number) => {
				if (cancelled) return resolve()
				// Catch up by elapsed time rather than one char per frame, so a
				// dropped frame doesn't slow the line down.
				let budget = Math.floor((now - last) / stepMs)
				if (budget > 0) {
					last += budget * stepMs
					while (budget > 0 && part < parts.length) {
						const current = parts[part]
						if (!current) break
						const take = Math.min(budget, current.full.length - typed)
						// A zero-length chunk would spin this loop forever with
						// the main thread held; skip rather than trust the filter.
						if (take <= 0) {
							part += 1
							typed = 0
							continue
						}
						typed += take
						budget -= take
						current.node.data = current.full.slice(0, typed)
						if (typed >= current.full.length) {
							part += 1
							typed = 0
						}
					}
				}
				if (part < parts.length) requestAnimationFrame(tick)
				else resolve()
			}
			requestAnimationFrame(tick)
		})

	const run = async () => {
		while (!cancelled) {
			await waitForVisible()
			hideAll()
			await sleep(RESET_FADE_MS)

			// Results that sit together in one segment land together, so they
			// read as one response rather than three separate arrivals.
			let pending: HTMLElement[] = []
			const flush = async () => {
				if (!pending.length) return
				await sleep(RESULT_LATENCY_MS)
				pending.forEach(landResult)
				pending = []
				await sleep(READ_MS)
			}

			for (const line of lines) {
				if (cancelled) return
				await waitForVisible()
				const kind = line.dataset.type
				if (!kind) {
					pending.push(line)
					continue
				}
				await flush()
				showBox(line)
				await typeLine(line, kind === "prompt" ? PROMPT_CPS : CALL_CPS)
				caret.remove()
				await sleep(THINK_MS)
			}
			await flush()

			await sleep(HOLD_MS)
		}
	}

	const io = new IntersectionObserver(
		([entry]) => {
			inView = Boolean(entry?.isIntersecting)
		},
		{ rootMargin: "60px" },
	)
	io.observe(root)

	hideAll()
	run()
}

/** Every non-blank text node under `line`, in document order, with its text. */
function textChunks(line: HTMLElement): Chunk[] {
	const out: Chunk[] = []
	const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
	let node = walker.nextNode()
	while (node) {
		const text = node as Text
		if (text.data.trim()) out.push({ node: text, full: text.data })
		node = walker.nextNode()
	}
	return out
}
