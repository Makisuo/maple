import { cn } from "@maple/ui/utils"
import type { WidgetFixContext } from "./widget-fix-context"

interface WidgetFixAttachmentCardProps {
	ctx: WidgetFixContext
	className?: string
}

const shortId = (id: string): string => {
	const segments = id.split("-")
	const last = segments[segments.length - 1] ?? id
	return last.slice(0, 8)
}

export function WidgetFixAttachmentCard({ ctx, className }: WidgetFixAttachmentCardProps) {
	return (
		<div className={cn("mx-auto w-full max-w-3xl px-4 pt-3", className)}>
			<div className="relative overflow-hidden rounded-md border bg-card/80 shadow-sm backdrop-blur-sm bg-destructive/[0.04]">
				<div className="absolute inset-y-0 left-0 w-[3px] bg-destructive" aria-hidden />
				<div className="flex items-start gap-2 py-2.5 pr-2 pl-3.5">
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
							<span className="font-medium">Broken widget</span>
							<span className="size-0.5 rounded-full bg-muted-foreground/40" aria-hidden />
							<span className="font-mono normal-case tracking-normal">
								{shortId(ctx.dashboardId)}/{shortId(ctx.widgetId)}
							</span>
						</div>
						<div className="mt-1 truncate text-[13px] font-medium text-foreground">
							{ctx.widgetTitle || "Untitled widget"}
						</div>
						{(ctx.errorTitle || ctx.errorMessage) && (
							<div className="mt-2 space-y-0.5">
								{ctx.errorTitle && (
									<div className="text-[11px] font-medium text-destructive">
										{ctx.errorTitle}
									</div>
								)}
								{ctx.errorMessage && (
									<div className="text-[11px] text-destructive/80 line-clamp-2">
										{ctx.errorMessage}
									</div>
								)}
							</div>
						)}
					</div>
				</div>
			</div>
		</div>
	)
}
