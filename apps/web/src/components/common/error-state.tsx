import { Button } from "@maple/ui/components/ui/button"
import { formatBackendError } from "@/lib/error-messages"
import { cn } from "@maple/ui/lib/utils"

/**
 * Shared inline error state for failed data fetches.
 *
 * Speaks the product's own language: a "dropped signal" readout — a live
 * signal line that cuts out mid-stream, with a dashed trail where the data
 * should be — the same mini-monitor idiom as the alerts empty state's
 * QuietMonitor. Copy comes from `formatBackendError`, plus a recovery action
 * when the caller can offer one.
 *
 * - `panel` — centered block for main content areas (tables, detail views,
 *   chart cards). Fills its container height, so it can sit directly inside a
 *   widget card; pass `border-0` via className when the parent already draws
 *   a border.
 * - `row` — horizontal banner for slot-height sections (stat-card strips,
 *   toolbars) where a tall centered panel would distort the page rhythm.
 * - `inline` — compact left-aligned block for narrow chrome (filter sidebars,
 *   sub-sections).
 */
interface ErrorStateProps {
	error: unknown
	/** Overrides the title derived from the error. */
	title?: string
	/** Renders a "Try again" action wired to this callback (e.g. an atom refresh). */
	onRetry?: () => void
	variant?: "panel" | "row" | "inline"
	className?: string
}

export function ErrorState({ error, title, onRetry, variant = "panel", className }: ErrorStateProps) {
	const formatted = formatBackendError(error)
	const heading = title ?? formatted.title

	if (variant === "inline") {
		return (
			<div className={cn("flex flex-col gap-1.5 py-4", className)}>
				<div className="flex items-center gap-2">
					<span
						className="flex size-5 shrink-0 items-center justify-center rounded-md bg-destructive/10 text-destructive"
						aria-hidden="true"
					>
						<SignalBreakTick />
					</span>
					<p className="text-xs font-medium text-foreground">{heading}</p>
				</div>
				<p className="text-xs whitespace-pre-wrap text-muted-foreground">{formatted.description}</p>
				{onRetry && (
					<Button
						size="sm"
						variant="ghost"
						onClick={onRetry}
						className="-ml-2 h-6 w-fit px-2 text-xs text-muted-foreground hover:text-foreground"
					>
						Try again
					</Button>
				)}
			</div>
		)
	}

	if (variant === "row") {
		return (
			<div
				className={cn(
					"flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border border-dashed px-4 py-3.5",
					className,
				)}
			>
				<DroppedSignalGlyph compact />
				<div className="min-w-0 flex-1 basis-56 space-y-0.5">
					<p className="text-sm font-medium text-foreground">{heading}</p>
					<p className="line-clamp-2 text-xs text-muted-foreground">{formatted.description}</p>
				</div>
				{onRetry && (
					<Button size="sm" variant="outline" className="shrink-0" onClick={onRetry}>
						Try again
					</Button>
				)}
			</div>
		)
	}

	return (
		<div
			className={cn(
				"flex h-full flex-col items-center justify-center gap-4 rounded-lg border border-dashed px-6 py-8 text-center",
				className,
			)}
		>
			<div className="rounded-lg border bg-card/50 px-3 py-2.5">
				<DroppedSignalGlyph />
			</div>
			<div className="max-w-xs space-y-1">
				<p className="text-sm font-medium text-foreground">{heading}</p>
				<p className="text-xs whitespace-pre-wrap text-muted-foreground">{formatted.description}</p>
			</div>
			{onRetry && (
				<Button size="sm" variant="outline" onClick={onRetry}>
					Try again
				</Button>
			)}
		</div>
	)
}

/**
 * The dropped-signal readout: a steady signal line that cuts out, a pulsing
 * destructive marker at the break, and a dashed trail where the data should
 * be. Pulse reuses `.infra-pulse` (carries its own reduced-motion guard).
 */
function DroppedSignalGlyph({ compact = false }: { compact?: boolean }) {
	return (
		<svg
			width={compact ? 64 : 176}
			height={compact ? 18 : 50}
			viewBox="0 0 200 56"
			fill="none"
			aria-hidden="true"
			className="shrink-0"
		>
			{/* Faint chart gridlines to set the "readout" frame. */}
			<line x1="4" y1="12" x2="196" y2="12" className="stroke-border" strokeWidth="1" opacity="0.5" />
			<line x1="4" y1="44" x2="196" y2="44" className="stroke-border" strokeWidth="1" opacity="0.5" />
			{/* The live signal — steady until it isn't. */}
			<polyline
				points="6,32 20,30 32,33 44,28 56,31 68,27 80,31 92,29 104,33 116,30"
				fill="none"
				className="stroke-muted-foreground"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				opacity="0.7"
			/>
			{/* Dashed trail — where the data should be. */}
			<line
				x1="130"
				y1="30"
				x2="194"
				y2="30"
				className="stroke-destructive"
				strokeWidth="1.5"
				strokeDasharray="3 5"
				strokeLinecap="round"
				opacity="0.45"
			/>
			{/* The break point. */}
			<circle
				cx="118"
				cy="30"
				r="5.5"
				className="infra-pulse fill-destructive"
				style={{ transformBox: "fill-box", transformOrigin: "center" }}
				opacity="0.35"
			/>
			<circle cx="118" cy="30" r="2.5" className="fill-destructive" />
		</svg>
	)
}

/** The break motif at icon scale, for the inline variant's chip. */
function SignalBreakTick() {
	return (
		<svg width={12} height={12} viewBox="0 0 12 12" fill="none" aria-hidden="true">
			<polyline
				points="1,7 3,6 5,7.5 6.5,6"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<circle cx="7.5" cy="6" r="1.25" fill="currentColor" />
			<line
				x1="9.5"
				y1="6"
				x2="11.5"
				y2="6"
				stroke="currentColor"
				strokeWidth="1.25"
				strokeDasharray="1.5 1.75"
				strokeLinecap="round"
				opacity="0.6"
			/>
		</svg>
	)
}
