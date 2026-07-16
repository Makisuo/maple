import type React from "react"

import { motion, useReducedMotion } from "motion/react"

import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { cn } from "@maple/ui/lib/utils"
import { IntegrationIconPlate } from "./integration-catalog"

/**
 * Brand take on `EmptyMedia variant="icon"`: a brand-washed icon plate with two
 * plain plates fanned behind it (the same ±10° / scale geometry the shared Empty
 * media uses), so every integration empty state reads as one family.
 */
function IntegrationEmptyMedia({
	icon,
	accent,
	iconClassName,
}: {
	icon: React.ComponentType<{ size?: number; className?: string }>
	accent: string
	iconClassName?: string
}) {
	const backer = "absolute bottom-px size-12 rounded-xl border border-border/60 bg-card"
	return (
		<div className="relative mb-6 flex items-end justify-center">
			<span
				aria-hidden
				className={cn(backer, "origin-bottom-left -translate-x-1.5 -rotate-10 scale-90")}
			/>
			<span
				aria-hidden
				className={cn(backer, "origin-bottom-right translate-x-1.5 rotate-10 scale-90")}
			/>
			<IntegrationIconPlate
				icon={icon}
				accent={accent}
				iconClassName={iconClassName}
				size={24}
				plateClassName="relative size-12 rounded-xl"
			/>
		</div>
	)
}

/** One value-prop tile in the not-connected feature grid. */
export interface IntegrationFeature {
	icon: React.ComponentType<{ size?: number; className?: string }>
	title: string
	description: string
}

const GRID_VARIANTS = {
	hidden: {},
	show: {
		transition: { staggerChildren: 0.05, delayChildren: 0.05 },
	},
}

const ITEM_VARIANTS = {
	hidden: { opacity: 0, y: 6 },
	show: {
		opacity: 1,
		y: 0,
		transition: { duration: 0.32, ease: [0.16, 1, 0.3, 1] as const },
	},
}

/**
 * The what-you-get grid: one quiet tile per feature, brand-tinted glyph chip,
 * title, one-line description. Informational only — no hover/click affordances.
 */
function FeatureGrid({
	features,
	accent,
	monochrome,
}: {
	features: ReadonlyArray<IntegrationFeature>
	accent: string
	/** Monochrome brand marks (GitHub) have a near-invisible accent on one theme — tint neutrally. */
	monochrome: boolean
}) {
	const reduceMotion = useReducedMotion()
	// Same fallback rule as IntegrationIconPlate: a mark that needed a color override
	// has an accent too dark/light to tint with, so derive the chip wash from the
	// theme-aware neutral instead.
	const wash = monochrome ? "var(--muted-foreground)" : accent
	return (
		<motion.ul
			className="grid w-full max-w-2xl grid-cols-1 gap-2 text-left sm:grid-cols-3"
			variants={GRID_VARIANTS}
			initial={reduceMotion ? false : "hidden"}
			animate="show"
		>
			{features.map((feature) => {
				const Icon = feature.icon
				return (
					<motion.li
						key={feature.title}
						variants={ITEM_VARIANTS}
						className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-card/50 p-3"
					>
						<div className="flex items-center gap-2">
							<span
								className="flex size-6 shrink-0 items-center justify-center rounded-md"
								style={{
									background: `color-mix(in srgb, ${wash} 12%, transparent)`,
									color: monochrome ? "var(--foreground)" : accent,
								}}
								aria-hidden
							>
								<Icon size={13} />
							</span>
							<span className="font-medium text-sm">{feature.title}</span>
						</div>
						<p className="text-xs text-muted-foreground">{feature.description}</p>
					</motion.li>
				)
			})}
		</motion.ul>
	)
}

/**
 * The shared integration empty state — one shape for every drill-in's not-connected /
 * no-items view: brand triple-stacked icon, title, description, optional feature
 * tiles, a primary action, and optional helper text. Keeps GitHub/Hazel/Cloudflare/scrape aligned.
 */
export function IntegrationEmptyState({
	icon,
	accent,
	iconClassName,
	title,
	description,
	features,
	children,
	footer,
	className,
}: {
	icon: React.ComponentType<{ size?: number; className?: string }>
	accent: string
	iconClassName?: string
	title: string
	description: React.ReactNode
	/** Optional value-prop tiles rendered as a feature grid between the copy and the action. */
	features?: ReadonlyArray<IntegrationFeature>
	/** Primary action(s). */
	children?: React.ReactNode
	/** Helper text shown under the action. */
	footer?: React.ReactNode
	className?: string
}) {
	return (
		<Empty className={cn("rounded-lg border border-border/60 bg-card py-12 md:py-12", className)}>
			<EmptyHeader>
				<IntegrationEmptyMedia icon={icon} accent={accent} iconClassName={iconClassName} />
				<EmptyTitle className="text-base">{title}</EmptyTitle>
				<EmptyDescription>{description}</EmptyDescription>
			</EmptyHeader>

			{features && features.length > 0 ? (
				<FeatureGrid features={features} accent={accent} monochrome={iconClassName != null} />
			) : null}

			{children || footer ? (
				<EmptyContent>
					{children}
					{footer ? <p className="text-xs text-muted-foreground">{footer}</p> : null}
				</EmptyContent>
			) : null}
		</Empty>
	)
}
