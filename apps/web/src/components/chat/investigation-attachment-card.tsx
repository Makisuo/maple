import { cn } from "@maple/ui/utils"
import type { InvestigationContext, InvestigationKind } from "./investigation-context"

const ACCENT: Record<string, { stripe: string; tint: string }> = {
	critical: { stripe: "bg-destructive", tint: "bg-destructive/[0.04]" },
	high: { stripe: "bg-orange-500", tint: "bg-orange-500/[0.04]" },
	warning: { stripe: "bg-warning", tint: "bg-warning/[0.04]" },
	medium: { stripe: "bg-amber-500", tint: "bg-amber-500/[0.04]" },
	low: { stripe: "bg-muted-foreground", tint: "bg-muted/30" },
}

const KIND_LABEL: Record<InvestigationKind, string> = {
	alert: "Attached alert",
	anomaly: "Attached anomaly",
	error: "Attached error",
}

const STATUS_TONE: Record<string, string> = {
	Firing: "text-destructive",
	Open: "text-destructive",
	Resolved: "text-success",
}

const shortId = (id: string): string => {
	const segments = id.split("-")
	return segments.length > 1 ? segments[segments.length - 1]!.slice(0, 8) : id.slice(0, 8)
}

/** Pinned card above the chat thread — the investigation subject, any kind. */
export function InvestigationAttachmentCard({
	ctx,
	className,
}: {
	ctx: InvestigationContext
	className?: string
}) {
	const accent = ACCENT[ctx.severity] ?? { stripe: "bg-muted-foreground", tint: "bg-muted/30" }
	const statusTone = STATUS_TONE[ctx.status] ?? "text-muted-foreground"
	const dot = ctx.status === "Resolved" ? "bg-success" : accent.stripe

	return (
		<div className={cn("mx-auto w-full max-w-3xl px-4 pt-3", className)}>
			<div
				className={cn(
					"relative overflow-hidden rounded-md border bg-card/80 shadow-sm backdrop-blur-sm",
					accent.tint,
				)}
			>
				<div className={cn("absolute inset-y-0 left-0 w-[3px]", accent.stripe)} aria-hidden />
				<div className="flex items-start gap-2 py-2.5 pr-3 pl-3.5">
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
							<span className="font-medium">{KIND_LABEL[ctx.kind]}</span>
							<span className="size-0.5 rounded-full bg-muted-foreground/40" aria-hidden />
							<span className="font-mono capitalize">{ctx.severity}</span>
							<span className="size-0.5 rounded-full bg-muted-foreground/40" aria-hidden />
							<span className={cn("inline-flex items-center gap-1 font-mono", statusTone)}>
								<span className={cn("size-1.5 rounded-full", dot)} aria-hidden />
								{ctx.status}
							</span>
							<span className="size-0.5 rounded-full bg-muted-foreground/40" aria-hidden />
							<span className="font-mono normal-case tracking-normal">#{shortId(ctx.id)}</span>
						</div>
						<div className="mt-1 truncate text-[13px] font-medium text-foreground">
							{ctx.title}
						</div>
						{ctx.facts.length > 0 ? (
							<ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
								{ctx.facts.map((fact) => (
									<li key={fact.key} className="flex min-w-0 flex-col leading-tight">
										<span className="text-[9px] uppercase tracking-[0.14em] text-muted-foreground/70">
											{fact.label}
										</span>
										<span className="truncate font-mono text-[11.5px] text-foreground">
											{fact.value}
										</span>
									</li>
								))}
							</ul>
						) : null}
					</div>
				</div>
			</div>
		</div>
	)
}
