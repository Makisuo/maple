import * as React from "react"
import "@rrweb/replay/dist/style.css"
import { cn } from "@maple/ui/lib/utils"
import { type DisplayMarker, type IdleBand, errorMessage, useReplayPlayer } from "./replay-player-context"
import {
	GlobeIcon,
	ArrowPathIcon,
	EyeIcon,
	MediaPlayIcon,
	MediaPauseIcon,
	MaximizeIcon,
	MinimizeIcon,
} from "@/components/icons"
import { formatClock, hostFromUrl, MARKER_STYLES } from "./replay-format"
import { MarkerLegend } from "./marker-legend"
import { useReplayKeyboardShortcuts } from "@/hooks/use-replay-keyboard-shortcuts"

const SPEEDS = [0.5, 1, 2, 4, 8] as const

/** Host + path for the faux browser address bar; blank URL reads as about:blank. */
function prettyUrl(url: string | undefined): string {
	return url ? hostFromUrl(url) : "about:blank"
}

/**
 * The replay video surface + its own transport — a self-contained "normal"
 * player: rrweb-rebuilt page inside faux-browser chrome, with play/scrub/speed
 * controls below. The engine and all transport state live in
 * `ReplayPlayerProvider`, so this player and the `<ReplayEditorTimeline>` strip
 * below it read and drive the same playhead.
 */
export function ReplaySurface({
	url,
	detachedTransport = false,
	docked = false,
}: {
	url?: string
	/** Render only the browser chrome + video; the caller places `<ReplayTransport>`
	 *  separately (so a side panel can match just the video block). Fullscreen always
	 *  keeps the controls inside the figure. */
	detachedTransport?: boolean
	/** A docked `<ReplayTransport docked>` sits flush below: square off the bottom
	 *  corners so surface + transport read as one unit. */
	docked?: boolean
}) {
	const { status, error, sessionActive, figureRef, surfaceRef, mountRef, isFullscreen } = useReplayPlayer()
	// A scrubber over a session that has no recording is a dead control; drop the
	// whole transport rather than offer it.
	const showTransport = status !== "unrecorded"

	// Page-wide Space/←/→ transport — Space to play/pause, arrows to seek ±5s.
	useReplayKeyboardShortcuts()

	return (
		<figure
			ref={figureRef}
			className={cn(
				"m-0 overflow-hidden rounded-xl border border-border bg-card shadow-sm",
				docked && "rounded-b-none shadow-none",
				isFullscreen && "flex h-screen w-screen flex-col rounded-none border-0 bg-black",
			)}
		>
			{/* Browser chrome */}
			<div className="flex items-center gap-3 border-b border-border bg-muted/40 px-3.5 py-2.5">
				<div className="flex items-center gap-1.5" aria-hidden>
					<span className="size-3 rounded-full bg-[#ff5f57]" />
					<span className="size-3 rounded-full bg-[#febc2e]" />
					<span className="size-3 rounded-full bg-[#28c840]" />
				</div>
				<div className="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-background/80 px-2.5 py-1 text-xs text-muted-foreground ring-1 ring-inset ring-border">
					<GlobeIcon className="size-3.5 shrink-0 opacity-70" />
					<span className="truncate font-mono">{prettyUrl(url)}</span>
				</div>
			</div>

			{/* Surface — the engine mounts into the inner div. Messages overlay when
			    there's nothing playable. The mount stays in the tree across statuses
			    so its ref is attached when the provider's engine effect runs. */}
			<div
				ref={surfaceRef}
				className={cn(
					// Fixed box so the player height stays constant across recordings; the
					// rebuilt page is scaled to fit inside (letterboxed on the dark ground).
					"relative w-full overflow-hidden bg-neutral-900",
					isFullscreen ? "min-h-0 flex-1" : "aspect-video",
				)}
			>
				<div ref={mountRef} className="absolute inset-0" />
				{status !== "ready" && (
					<div className="absolute inset-0 bg-muted/30">
						{status === "loading" && <PlayerMessage spinner>Loading replay…</PlayerMessage>}
						{status === "error" && (
							<PlayerMessage tone="error">
								Couldn’t load this replay — {errorMessage(error)}
							</PlayerMessage>
						)}
						{status === "empty" && (
							<PlayerMessage spinner={sessionActive}>
								{sessionActive
									? "Recording in progress — frames appear as chunks finish uploading."
									: "This recording is too short to play back."}
							</PlayerMessage>
						)}
						{status === "unrecorded" && (
							<PlayerMessage>
								This session wasn’t recorded. Replay is off or unsampled for this app — its
								traces and events are still below.
							</PlayerMessage>
						)}
					</div>
				)}
			</div>

			{/* Transport stays inside the figure unless the caller renders it detached
			    below the surface. Fullscreen always keeps the controls in the figure. */}
			{showTransport && (!detachedTransport || isFullscreen) && (
				<>
					<ReplayControls />
					{/* Legend for the scrubber's action-marker dots — otherwise the colors
					    are undiscoverable. Hidden in fullscreen to keep the surface clean. */}
					{!isFullscreen && (
						<div className="flex items-center justify-between gap-3 border-t border-border bg-muted/20 px-3 py-1.5">
							<MarkerLegend />
						</div>
					)}
				</>
			)}
		</figure>
	)
}

/**
 * The transport controls, rendered detached from the player surface. Pair with
 * `<ReplaySurface detachedTransport />`. With `docked` it drops its own card
 * chrome and sits flush against a `<ReplaySurface docked>` above — one visual
 * unit, separated by the shared border. The marker legend then lives in the
 * timeline header instead of here.
 */
export function ReplayTransport({ docked = false }: { docked?: boolean }) {
	const { isFullscreen, status } = useReplayPlayer()
	// In fullscreen the controls live inside the fullscreen figure.
	if (isFullscreen) return null
	// Nothing was ever recorded — see `showTransport` in `<ReplaySurface>`.
	if (status === "unrecorded") return null
	if (docked) {
		return (
			<div className="overflow-hidden rounded-b-xl border border-t-0 border-border bg-card">
				<ReplayControls detached />
			</div>
		)
	}
	return (
		<div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
			<ReplayControls detached />
			<div className="flex items-center justify-between gap-3 border-t border-border bg-muted/20 px-3 py-1.5">
				<MarkerLegend />
			</div>
		</div>
	)
}

function ReplayControls({ detached = false }: { detached?: boolean }) {
	const {
		isPlaying,
		finished,
		displayCurrentMs,
		displayTotalMs,
		markers,
		idleBands,
		speed,
		skipInactive,
		isFullscreen,
		togglePlay,
		seekDisplay,
		changeSpeed,
		toggleSkipInactive,
		toggleFullscreen,
	} = useReplayPlayer()

	return (
		// On phones the controls stack into two rows; at ≥640px the inner wrappers
		// collapse to `display:contents` so everything flows into one row exactly as
		// before. Row 1 is play + scrubber + clock; row 2 is speed + skip + fullscreen.
		<div
			className={cn(
				"flex flex-col gap-2 bg-card px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3",
				// Attached: a divider from the surface above. Detached: it's the top of
				// its own card, so no divider.
				!detached && "border-t border-border",
			)}
		>
			<div className="flex items-center gap-3 sm:contents">
				<button
					type="button"
					onClick={togglePlay}
					aria-label={finished ? "Replay" : isPlaying ? "Pause" : "Play"}
					aria-keyshortcuts="Space"
					title={`${finished ? "Replay" : isPlaying ? "Pause" : "Play"} (Space)`}
					className="relative grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-transform hover:scale-105 active:scale-95 pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11"
				>
					{finished ? (
						<ArrowPathIcon className="size-4" />
					) : isPlaying ? (
						<MediaPauseIcon className="size-4" />
					) : (
						<MediaPlayIcon className="size-4 translate-x-px" />
					)}
				</button>

				<Scrubber
					currentMs={displayCurrentMs}
					totalMs={displayTotalMs}
					markers={markers}
					idleBands={idleBands}
					onSeek={seekDisplay}
				/>

				<div className="flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground">
					<span className="text-foreground">{formatClock(displayCurrentMs)}</span>
					<span className="opacity-50">/</span>
					<span>{formatClock(displayTotalMs)}</span>
				</div>
			</div>

			<div className="flex items-center gap-2 sm:contents">
				<div className="flex shrink-0 items-center rounded-md bg-muted p-0.5">
					{SPEEDS.map((s) => (
						<button
							key={s}
							type="button"
							onClick={() => changeSpeed(s)}
							className={cn(
								// Grouped control: expand the touch target vertically only
								// (min-h) so adjacent segments' hit areas don't overlap.
								"relative rounded px-1.5 py-0.5 text-xs font-medium tabular-nums transition-colors pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11",
								speed === s
									? "bg-background text-foreground shadow-sm"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{s}×
						</button>
					))}
				</div>

				<button
					type="button"
					onClick={toggleSkipInactive}
					aria-pressed={skipInactive}
					title={skipInactive ? "Idle gaps skipped during playback" : "Skip idle gaps"}
					className={cn(
						"relative shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-colors pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11",
						skipInactive
							? "bg-primary/10 text-primary"
							: "text-muted-foreground hover:bg-muted hover:text-foreground",
					)}
				>
					Skip idle
				</button>

				<button
					type="button"
					onClick={toggleFullscreen}
					aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
					title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
					className="relative grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground max-sm:ml-auto pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11"
				>
					{isFullscreen ? <MinimizeIcon className="size-4" /> : <MaximizeIcon className="size-4" />}
				</button>
			</div>
		</div>
	)
}

function Scrubber({
	currentMs,
	totalMs,
	markers,
	idleBands,
	onSeek,
}: {
	currentMs: number
	totalMs: number
	/** Action markers + idle bands, already in the same (display) ms space as totalMs. */
	markers: DisplayMarker[]
	idleBands: IdleBand[]
	onSeek: (ms: number) => void
}) {
	const trackRef = React.useRef<HTMLDivElement | null>(null)
	const [dragging, setDragging] = React.useState(false)
	const [hoverMs, setHoverMs] = React.useState<number | null>(null)
	const pct = totalMs > 0 ? Math.min(100, (currentMs / totalMs) * 100) : 0
	const hoverPct =
		hoverMs != null && totalMs > 0 ? Math.min(100, Math.max(0, (hoverMs / totalMs) * 100)) : null

	const msFromClientX = React.useCallback(
		(clientX: number) => {
			const el = trackRef.current
			if (!el) return 0
			const rect = el.getBoundingClientRect()
			const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0
			return Math.max(0, Math.min(1, ratio)) * totalMs
		},
		[totalMs],
	)

	return (
		<div
			ref={trackRef}
			role="slider"
			aria-label="Seek"
			aria-valuemin={0}
			aria-valuemax={Math.round(totalMs)}
			aria-valuenow={Math.round(currentMs)}
			tabIndex={0}
			onPointerDown={(e) => {
				e.currentTarget.setPointerCapture(e.pointerId)
				setDragging(true)
				onSeek(msFromClientX(e.clientX))
			}}
			onPointerMove={(e) => {
				const ms = msFromClientX(e.clientX)
				setHoverMs(ms)
				if (dragging) onSeek(ms)
			}}
			onPointerLeave={() => setHoverMs(null)}
			onPointerUp={(e) => {
				e.currentTarget.releasePointerCapture(e.pointerId)
				setDragging(false)
			}}
			className="group relative h-6 flex-1 cursor-pointer touch-none select-none"
		>
			{/* Hover time bubble — surfaces the timestamp under the cursor while
			    scanning, so seeking is precise. */}
			{hoverPct != null && (
				<div
					className="pointer-events-none absolute -top-7 z-10 -translate-x-1/2 rounded bg-popover px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-popover-foreground shadow-sm ring-1 ring-border"
					style={{ left: `${hoverPct}%` }}
				>
					{formatClock(hoverMs ?? 0)}
				</div>
			)}
			{/* Track */}
			<div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-muted">
				{/* Idle bands — greyed/hatched, under the progress fill */}
				{totalMs > 0 &&
					idleBands.map((band, i) => {
						const leftPct = Math.max(0, Math.min(100, (band.start / totalMs) * 100))
						const widthPct = Math.max(
							0,
							Math.min(100 - leftPct, ((band.end - band.start) / totalMs) * 100),
						)
						return (
							<span
								key={`idle-${band.start}-${i}`}
								className="absolute inset-y-0 bg-foreground/25"
								style={{
									left: `${leftPct}%`,
									width: `${widthPct}%`,
									minWidth: 3,
									backgroundImage:
										"repeating-linear-gradient(45deg, transparent 0 2px, rgba(0,0,0,0.18) 2px 4px)",
								}}
								title="Idle"
							/>
						)
					})}
				<div className="relative h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
			</div>
			{/* Action markers */}
			{totalMs > 0 &&
				markers.map((m, i) => {
					const markerPct = Math.min(100, Math.max(0, (m.ms / totalMs) * 100))
					return (
						<span
							key={`${m.kind}-${m.ms}-${i}`}
							className={cn(
								"absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-1 ring-card",
								MARKER_STYLES[m.kind],
							)}
							style={{ left: `${markerPct}%` }}
							title={m.kind}
						/>
					)
				})}
			{/* Thumb — hover-revealed on desktop, always shown on touch (no hover). */}
			<div
				className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background opacity-0 shadow-sm transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100"
				style={{ left: `${pct}%`, opacity: dragging ? 1 : undefined }}
			/>
		</div>
	)
}

function PlayerMessage({
	children,
	spinner,
	tone,
}: {
	children: React.ReactNode
	spinner?: boolean
	tone?: "error"
}) {
	return (
		<div className="flex aspect-video w-full items-center justify-center p-8">
			<div className="flex max-w-sm flex-col items-center gap-3 text-center">
				<div
					className={
						tone === "error"
							? "grid size-11 place-items-center rounded-full bg-destructive/10 text-destructive"
							: "grid size-11 place-items-center rounded-full bg-muted text-muted-foreground"
					}
				>
					{spinner ? (
						<ArrowPathIcon className="size-5 animate-spin" />
					) : (
						<EyeIcon className="size-5" />
					)}
				</div>
				<p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
			</div>
		</div>
	)
}
