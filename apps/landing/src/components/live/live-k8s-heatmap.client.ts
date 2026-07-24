/**
 * Cursor-following tooltip for the pod heatmap.
 *
 * The grid ships 192 cells, so this is one delegated `pointermove` on the grid
 * rather than a listener per cell, and the position write is rAF-coalesced —
 * a pointermove can fire more than once per frame and every write here is a
 * layout-affecting transform.
 *
 * Skipped entirely on coarse pointers: a tooltip that chases a cursor has no
 * meaning without a cursor. The SSR'd `title` attributes stay as the no-JS
 * fallback and are stripped here once we take over.
 */

/** Gap between the cursor and the tooltip's near edge. */
const CURSOR_OFFSET = 12
/** Flip above the cursor when within this much of the canvas floor. */
const FLIP_MARGIN = 44

export function wireHeatmap(root: HTMLElement) {
	if (root.dataset.heatmapAttached === "1") return

	const grid = root.querySelector<HTMLElement>("[data-k8s-grid]")
	const tip = root.querySelector<HTMLElement>("[data-k8s-tip]")
	const canvas = root.querySelector<HTMLElement>("[data-k8s-canvas]")
	if (!grid || !tip || !canvas) return

	// Coarse pointers keep the native tooltip — long-press still surfaces it on
	// some platforms, and a cursor-anchored box has nothing to anchor to.
	if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return

	root.dataset.heatmapAttached = "1"

	// We own the affordance now; drop the native tooltips so they don't
	// double-fire a second box a second later.
	const cells = grid.querySelectorAll<HTMLElement>(".k8s-hm-cell")
	for (let i = 0; i < cells.length; i += 1) {
		cells[i]?.removeAttribute("title")
	}

	const label = tip.querySelector<HTMLElement>("[data-k8s-tip-label]")
	const dot = tip.querySelector<HTMLElement>("[data-k8s-tip-dot]")

	let frame = 0
	let pendingX = 0
	let pendingY = 0
	let pendingCell: HTMLElement | null = null
	let shownCell: HTMLElement | null = null

	const paint = () => {
		frame = 0
		const cell = pendingCell
		if (!cell) return

		if (cell !== shownCell) {
			shownCell = cell
			const pod = cell.dataset.pod ?? ""
			const cpu = cell.dataset.cpu ?? ""
			const state = cell.dataset.state ?? ""
			if (label) label.textContent = `pod ${pod} · ${cpu}% cpu · ${state}`
			if (dot) dot.dataset.state = state
			tip.dataset.on = "1"
		}

		// Measured after the text lands, so the clamp uses this frame's width.
		const box = canvas.getBoundingClientRect()
		const w = tip.offsetWidth
		const h = tip.offsetHeight

		const flip = pendingY + FLIP_MARGIN > box.height
		const x = Math.min(Math.max(pendingX - w / 2, 0), Math.max(box.width - w, 0))
		const y = flip ? pendingY - h - CURSOR_OFFSET : pendingY + CURSOR_OFFSET

		tip.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`
	}

	grid.addEventListener("pointermove", (event) => {
		const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(".k8s-hm-cell")
		if (!target) return

		const box = canvas.getBoundingClientRect()
		pendingX = event.clientX - box.left
		pendingY = event.clientY - box.top
		pendingCell = target

		if (frame === 0) frame = requestAnimationFrame(paint)
	})

	const hide = () => {
		if (frame !== 0) {
			cancelAnimationFrame(frame)
			frame = 0
		}
		pendingCell = null
		shownCell = null
		tip.dataset.on = "0"
	}

	grid.addEventListener("pointerleave", hide)
	// A scroll under a stationary cursor leaves the tooltip pinned to a cell the
	// pointer is no longer over.
	window.addEventListener("scroll", hide, { passive: true })
}
