// The replay engine seam
//
// The player used to construct `new Replayer(...)` inline, which made rrweb the
// only thing it could ever play. The iOS SDK records H.264 segments and wraps
// each one in rrweb-*shaped* events so the chunk pipeline carries them
// untouched — but there is no DOM to rebuild, so rrweb renders nothing.
//
// Everything above this interface (the provider's transport state, the trimmed
// timeline, markers, idle bands, the chunk loader) is format-agnostic and stays
// exactly as it was. Everything rrweb-specific lives in `rrweb-engine.ts`;
// everything video-specific in `video-engine.ts`.
//
// The contract is deliberately shaped like the rrweb surface the provider
// already depended on, so the refactor is behaviour-preserving:
//
//   new Replayer(events, {root})   -> ReplayEngineFactory.create({mount, events})
//   getMetaData().totalTime        -> totalTimeMs
//   getCurrentTime()               -> getCurrentTimeMs()
//   play(o) / pause(o?)            -> play(o) / pause(o?)
//   setConfig({speed})             -> setSpeed(speed)
//   addEvent(e)                    -> addEvent(e)
//   destroy()                      -> destroy()
//   on(Finish) / on(Resize)        -> onFinish / onResize callbacks
//   .iframe + .wrapper.style       -> fit(container)

/** The recorded viewport, used to letterbox the recording inside the surface. */
export interface Viewport {
	readonly width: number
	readonly height: number
}

export interface ReplayEngineCreateInput {
	/** The surface's inner div. The engine owns its contents entirely. */
	readonly mount: HTMLElement
	/** The seed events. Later events arrive through `addEvent`, forward-only. */
	readonly events: ReadonlyArray<unknown>
	/**
	 * Viewport to fall back to when the engine can't report its own — derived
	 * from the stream's `meta` events by `deriveMeta`.
	 */
	readonly fallbackViewport: Viewport
	/** Playback reached the end of the recording. */
	onFinish(): void
	/** The recorded viewport changed mid-session; the surface must re-fit. */
	onResize(): void
}

export interface ReplayEngine {
	/** Length of the loaded recording, in real ms. */
	readonly totalTimeMs: number
	/**
	 * Playhead as a real-ms offset from session start, matching the clock the
	 * trimmed `Timeline` and backend span alignment are built against.
	 *
	 * Implementations must never return a negative or non-finite value — the
	 * provider feeds this straight back into `play()`.
	 */
	getCurrentTimeMs(): number
	play(offsetMs: number): void
	/** With no offset, hold at the current position. */
	pause(offsetMs?: number): void
	setSpeed(speed: number): void
	/**
	 * Append an event that arrived after construction.
	 *
	 * Forward-only by contract: every trailing event postdates the seed. A
	 * backward seek rebuilds the engine from the nearest checkpoint instead
	 * (see `requestSeek` in `use-replay-chunk-loader.ts`).
	 */
	addEvent(event: unknown): void
	/** Fit the recording inside `container`, letterboxed and centred. */
	fit(container: HTMLElement): void
	destroy(): void
}

export interface ReplayEngineFactory {
	create(input: ReplayEngineCreateInput): ReplayEngine
}

/**
 * Which engine plays a session's chunks.
 *
 * Carried by the `maple.session.replay_format` resource attribute so the player
 * can pick an engine from session metadata alone, without downloading a chunk
 * to find out. An absent attribute means `rrweb` — every session recorded
 * before the marker existed is a browser recording.
 */
export type ReplayFormat = "rrweb" | "video"
