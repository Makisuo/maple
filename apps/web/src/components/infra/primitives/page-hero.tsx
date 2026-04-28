import * as React from "react"
import { cn } from "@maple/ui/lib/utils"

interface PageHeroProps {
	title: React.ReactNode
	description?: React.ReactNode
	meta?: React.ReactNode
	actions?: React.ReactNode
	trailing?: React.ReactNode
	/** @deprecated retained for back-compat — no longer rendered. */
	eyebrow?: string
	className?: string
}

export function PageHero({ title, description, meta, actions, trailing, className }: PageHeroProps) {
	return (
		<header className={cn("flex flex-wrap items-start gap-x-6 gap-y-3", className)}>
			<div className="min-w-0 flex-1 space-y-1">
				<div className="flex flex-wrap items-baseline gap-3">
					<h1 className="text-2xl font-semibold leading-tight tracking-tight text-foreground">
						{title}
					</h1>
					{trailing}
				</div>
				{description ? (
					<p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
				) : null}
				{meta ? <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div> : null}
			</div>
			{actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
		</header>
	)
}

export function HeroChip({ children }: { children: React.ReactNode }) {
	return (
		<span className="inline-flex items-center gap-1 rounded-sm border border-border/70 bg-background/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
			{children}
		</span>
	)
}
