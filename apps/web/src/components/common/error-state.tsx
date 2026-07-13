import { Button } from "@maple/ui/components/ui/button"
import { formatBackendError } from "@/lib/error-messages"
import { cn } from "@maple/ui/lib/utils"

/**
 * Shared inline error state for failed data fetches.
 *
 * Speaks the same visual language as the app crash screen
 * (`app-error-boundary.tsx`): a small trace waterfall with an errored span
 * standing in for a generic warning icon, quiet neutral copy from
 * `formatBackendError`, and a recovery action when the caller can offer one.
 *
 * - `panel` — centered block for main content areas (tables, detail views,
 *   chart cards).
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
					<span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
					<p className="text-xs font-medium text-foreground">{heading}</p>
				</div>
				<p className="text-xs whitespace-pre-wrap text-muted-foreground">{formatted.description}</p>
				{onRetry && (
					<button
						type="button"
						onClick={onRetry}
						className="w-fit text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
					>
						Try again
					</button>
				)}
			</div>
		)
	}

	if (variant === "row") {
		return (
			<div
				className={cn(
					"flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border border-dashed px-4 py-4",
					className,
				)}
			>
				<ErrorTraceGlyph compact />
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
				"flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center",
				className,
			)}
		>
			<ErrorTraceGlyph />
			<div className="max-w-sm space-y-1">
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

/** Mini trace waterfall with an errored span — the crash screen's motif at icon scale. */
function ErrorTraceGlyph({ compact = false }: { compact?: boolean }) {
	return (
		<svg
			width={compact ? 56 : 88}
			height={compact ? 19 : 30}
			viewBox="0 0 88 30"
			fill="none"
			aria-hidden="true"
			className="shrink-0"
		>
			<rect x={0} y={0} width={88} height={6} rx={3} className="fill-muted-foreground/25" />
			<rect x={12} y={12} width={50} height={6} rx={3} className="fill-muted-foreground/25" />
			<rect x={26} y={24} width={28} height={6} rx={3} className="fill-destructive" />
			<rect x={53.5} y={0} width={1.5} height={30} rx={0.75} className="fill-destructive/50" />
		</svg>
	)
}
