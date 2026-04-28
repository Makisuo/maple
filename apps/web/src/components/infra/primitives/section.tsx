import * as React from "react"
import { cn } from "@maple/ui/lib/utils"

interface SectionProps extends React.HTMLAttributes<HTMLElement> {
	children: React.ReactNode
}

export function Section({ children, className, ...rest }: SectionProps) {
	return (
		<section className={cn("space-y-3", className)} {...rest}>
			{children}
		</section>
	)
}

interface SectionEyebrowProps {
	label: string
	meta?: React.ReactNode
	actions?: React.ReactNode
	className?: string
}

export function SectionEyebrow({ label, meta, actions, className }: SectionEyebrowProps) {
	return (
		<div className={cn("flex items-baseline gap-3 border-b border-border/60 pb-1.5", className)}>
			<span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
				{label}
			</span>
			{meta ? (
				<span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">{meta}</span>
			) : null}
			{actions ? <div className="ml-auto">{actions}</div> : null}
		</div>
	)
}

export function SectionRule({ className }: { className?: string }) {
	return <hr className={cn("border-t border-border/60", className)} />
}
