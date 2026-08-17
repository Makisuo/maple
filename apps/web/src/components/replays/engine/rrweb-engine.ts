import { Replayer } from "@rrweb/replay"
import { ReplayerEvents } from "@rrweb/types"
import type { ReplayEngine, ReplayEngineCreateInput, ReplayEngineFactory } from "./replay-engine"

// The rrweb engine — browser recordings.
//
// This is the behaviour the player has always had, moved behind the engine
// interface unchanged. Every quirk documented here was a shipped bug once.

class RrwebEngine implements ReplayEngine {
	private readonly replayer: Replayer
	private readonly fallbackViewport: ReplayEngineCreateInput["fallbackViewport"]

	constructor(input: ReplayEngineCreateInput) {
		const accent =
			getComputedStyle(document.documentElement).getPropertyValue("--primary").trim() || "#6366f1"

		this.fallbackViewport = input.fallbackViewport
		this.replayer = new Replayer(input.events as never, {
			root: input.mount,
			speed: 1,
			// We skip idle ourselves by jumping (see the provider's rAF loop) —
			// rrweb's own skipInactive only fast-forwards, which is slow. Keep it off.
			skipInactive: false,
			mouseTail: { duration: 600, lineCap: "round", lineWidth: 3, strokeStyle: accent },
			showWarning: false,
			showDebug: false,
			liveMode: false,
		})

		// rrweb's own transport events are unreliable in @rrweb/replay (Start/Resume
		// often don't fire); play/pause state is driven from the provider's handlers.
		// We still honour Finish to flip back to the replay affordance at the end.
		this.replayer.on(ReplayerEvents.Finish, () => input.onFinish())
		// The recorded viewport can change mid-session (responsive / window resize);
		// rrweb resizes its iframe and emits Resize. Also fires for the initial snapshot.
		this.replayer.on(ReplayerEvents.Resize, () => input.onResize())
	}

	get totalTimeMs(): number {
		return this.replayer.getMetaData().totalTime
	}

	/**
	 * Read the playhead, treating "not started yet" as 0.
	 *
	 * rrweb builds its player context with `baselineTime: 0`, and
	 * `getCurrentTime()` is `timer.timeOffset + (baselineTime - events[0].timestamp)`
	 * — so until the engine has been driven by a `play()` / `pause(offset)` (the only
	 * things that assign `baselineTime`), it reports `-events[0].timestamp`: a
	 * negative epoch, ~55 years. Feeding that back into `play()` re-bases the whole
	 * stream decades into the future and nothing ever casts, which is what left the
	 * player frozen at 0:00 until the first scrub re-based it for us.
	 */
	getCurrentTimeMs(): number {
		const ms = this.replayer.getCurrentTime()
		return Number.isFinite(ms) && ms > 0 ? ms : 0
	}

	play(offsetMs: number): void {
		this.replayer.play(offsetMs)
	}

	pause(offsetMs?: number): void {
		this.replayer.pause(offsetMs)
	}

	setSpeed(speed: number): void {
		this.replayer.setConfig({ speed })
	}

	addEvent(event: unknown): void {
		this.replayer.addEvent(event as never)
	}

	/**
	 * Fit the recorded page *inside* the surface (contain + letterbox), centered on
	 * both axes. The surface keeps a constant box (CSS aspect-ratio / fullscreen
	 * flex), so the player height never jumps between recordings.
	 *
	 * Scale against the iframe rrweb actually built, not the statically-derived
	 * fallback — a session can carry several Meta events (viewport resizes), and
	 * `deriveMeta` keeps the last one, which may not match the current frame. The
	 * iframe's width/height *attributes* always reflect the current viewport, and
	 * the `Resize` listener re-runs this when they change mid-playback.
	 */
	fit(container: HTMLElement): void {
		const vw = Number(this.replayer.iframe?.getAttribute("width")) || this.fallbackViewport.width
		const vh = Number(this.replayer.iframe?.getAttribute("height")) || this.fallbackViewport.height
		const availW = container.clientWidth
		const availH = container.clientHeight
		if (!availW || !availH || !vw || !vh) return
		const scale = Math.min(availW / vw, availH / vh)
		const offsetX = Math.max(0, (availW - vw * scale) / 2)
		const offsetY = Math.max(0, (availH - vh * scale) / 2)
		this.replayer.wrapper.style.transformOrigin = "top left"
		this.replayer.wrapper.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`
	}

	destroy(): void {
		this.replayer.destroy()
	}
}

export const rrwebEngineFactory: ReplayEngineFactory = {
	create: (input) => new RrwebEngine(input),
}
