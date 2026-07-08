import { Link } from "@tanstack/react-router"

import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { cn } from "@maple/ui/utils"

import { PlusIcon } from "@/components/icons"
import { ALERT_TEMPLATES, type AlertTemplate } from "@/lib/alerts/templates"

/**
 * First-run empty state for the alerts overview (zero rules). Replaces the
 * generic bell-badge with an operator-console "quiet monitor" readout — a live
 * signal held below a not-yet-placed threshold — then surfaces the five real
 * starter templates as brand-colored, one-click deep links into a pre-filled
 * create form. Non-admins get the readout + a nudge, no create affordances.
 *
 * The tile hues mirror `BUILTIN_SIGNAL_OPTIONS` on the create form
 * (signal-and-threshold-section.tsx) so a template reads with the same color it
 * paints on the live chart. Kept here rather than on the pure `ALERT_TEMPLATES`
 * module so `templates.ts` stays React-free beyond its display icons.
 */
const TILE_TONE: Record<AlertTemplate["id"], { glyph: string; hoverBorder: string }> = {
	high_error_rate: { glyph: "bg-chart-error/10 text-chart-error", hoverBorder: "hover:border-chart-error/50" },
	slow_p95: { glyph: "bg-chart-p95/10 text-chart-p95", hoverBorder: "hover:border-chart-p95/50" },
	slow_p99: { glyph: "bg-chart-p99/10 text-chart-p99", hoverBorder: "hover:border-chart-p99/50" },
	low_apdex: { glyph: "bg-chart-apdex/10 text-chart-apdex", hoverBorder: "hover:border-chart-apdex/50" },
	throughput_drop: {
		glyph: "bg-chart-throughput/10 text-chart-throughput",
		hoverBorder: "hover:border-chart-throughput/50",
	},
}

export function AlertsEmptyState({ isAdmin, serviceName }: { isAdmin: boolean; serviceName?: string }) {
	return (
		<Empty className="py-12">
			<QuietMonitor />
			<EmptyHeader>
				<EmptyTitle>No rules are watching yet</EmptyTitle>
				<EmptyDescription>
					{isAdmin
						? "A threshold rule opens an incident the moment a signal crosses it. Start from a common one:"
						: "Ask an admin to create the first alert rule."}
				</EmptyDescription>
			</EmptyHeader>

			{isAdmin && (
				<div className="flex w-full max-w-3xl flex-col items-center gap-4">
					<div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
						{ALERT_TEMPLATES.map((template) => (
							<TemplateTile key={template.id} template={template} serviceName={serviceName} />
						))}
					</div>
					<Button
						variant="ghost"
						size="sm"
						render={<Link to="/alerts/create" search={{ serviceName }} />}
					>
						<PlusIcon size={14} />
						Start from scratch
					</Button>
				</div>
			)}
		</Empty>
	)
}

function TemplateTile({ template, serviceName }: { template: AlertTemplate; serviceName?: string }) {
	const Icon = template.icon
	const tone = TILE_TONE[template.id]
	return (
		<Link
			to="/alerts/create"
			search={{ template: template.id, serviceName }}
			className={cn(
				"group flex flex-col gap-1.5 rounded-lg border bg-card p-3 text-left transition-colors",
				"hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
				tone.hoverBorder,
			)}
		>
			<div className="flex items-center gap-2">
				<span
					className={cn("flex size-6 shrink-0 items-center justify-center rounded-md", tone.glyph)}
				>
					<Icon size={13} />
				</span>
				<span className="font-medium text-sm">{template.title}</span>
			</div>
			<code className="font-mono text-[11px] text-muted-foreground">{template.summary}</code>
		</Link>
	)
}

/**
 * The signature graphic: a live signal (muted, with a pulsing leading edge)
 * running steadily below a dashed amber threshold that hasn't been placed yet —
 * the exact thing a rule adds. The threshold reuses `.infra-ref-line` (dashed
 * draw-in) and the leading dot reuses `.infra-pulse`; both idioms already carry
 * their own `prefers-reduced-motion` guards from styles.css.
 */
function QuietMonitor() {
	return (
		<div className="relative w-full max-w-[300px] overflow-hidden rounded-lg border bg-card/50 px-4 py-3">
			<svg viewBox="0 0 300 84" className="w-full" role="img" aria-label="No threshold is watching yet">
				<title>A steady signal running below an unset alert threshold</title>
				{/* Dashed amber threshold — the line a rule would place. */}
				<g className="infra-ref-line">
					<line x1="10" y1="26" x2="290" y2="26" className="stroke-primary" strokeWidth="1.5" opacity="0.55" />
				</g>
				{/* Live, steady signal well below the threshold. */}
				<polyline
					points="10,60 30,58 48,61 66,57 86,60 104,58 124,61 142,59 160,57 178,60 196,58 214,61 232,58 250,60 268,58 290,59"
					fill="none"
					className="stroke-muted-foreground"
					strokeWidth="1.75"
					strokeLinecap="square"
					strokeLinejoin="round"
					opacity="0.7"
				/>
				{/* Pulsing leading edge — signals are flowing, nothing is watching them. */}
				<circle
					cx="290"
					cy="59"
					r="4"
					className="infra-pulse fill-primary"
					style={{ transformBox: "fill-box", transformOrigin: "center" }}
					opacity="0.5"
				/>
				<circle cx="290" cy="59" r="2.5" className="fill-primary" />
			</svg>
		</div>
	)
}
