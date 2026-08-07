import { Children, createContext, isValidElement, use } from "react"
import type React from "react"

import { cn } from "@maple/ui/lib/utils"
import { IntegrationIconPlate } from "./integration-catalog"

type IntegrationGlyph = React.ComponentType<{ size?: number; className?: string }>

/**
 * Brand identity shared by every part of the empty state — provided once by
 * `IntegrationEmpty` so `IntegrationEmptyMedia` (and anything else that renders
 * the provider mark) never needs it re-passed.
 */
interface IntegrationEmptyContextValue {
	icon: IntegrationGlyph
	/**
	 * Glyph for the two dimmed backer plates — defaults to `icon`. Multicolor marks
	 * hard-code their path fills, so the backers' `text-muted-foreground/70` can't
	 * reach them and all three plates render equally loud, flattening the depth
	 * hierarchy. Pass the mark's monochrome variant (e.g. `SlackMonoIcon`) so the
	 * backers recede and the center plate keeps the brand color to itself.
	 */
	backerIcon?: IntegrationGlyph
	accent: string
	/** Set for monochrome marks (GitHub) — glyph tints via className, wash goes neutral. */
	iconClassName?: string
}

const IntegrationEmptyContext = createContext<IntegrationEmptyContextValue | null>(null)

function useIntegrationEmptyContext(caller: string): IntegrationEmptyContextValue {
	const context = use(IntegrationEmptyContext)
	if (context === null) {
		throw new Error(`<${caller}> must be rendered inside <IntegrationEmpty>`)
	}
	return context
}

/**
 * The shared drill-in empty state, one compound family for every integration's
 * not-connected / no-items view:
 *
 * ```tsx
 * <IntegrationEmpty icon={CloudflareIcon} backerIcon={CloudflareMonoIcon} accent={CLOUDFLARE_ACCENT}>
 *   <IntegrationEmptyFeatures>
 *     <IntegrationEmptyFeature label="Zone analytics" title="…" description="…" />
 *   </IntegrationEmptyFeatures>
 *   <IntegrationEmptyCard>
 *     <IntegrationEmptyMedia />
 *     <IntegrationEmptyHint>…appears here after connecting.</IntegrationEmptyHint>
 *     <Button>…</Button>
 *     <IntegrationEmptyFooter>Read-only OAuth · …</IntegrationEmptyFooter>
 *   </IntegrationEmptyCard>
 * </IntegrationEmpty>
 * ```
 *
 * Marks whose fills are hard-coded per path (Slack) additionally pass
 * `backerIcon={SlackMonoIcon}` so the dim backer plates don't render at full brand
 * saturation next to the colored center plate.
 */
export function IntegrationEmpty({
	icon,
	backerIcon,
	accent,
	iconClassName,
	className,
	children,
}: IntegrationEmptyContextValue & {
	className?: string
	children: React.ReactNode
}) {
	return (
		<IntegrationEmptyContext value={{ icon, backerIcon, accent, iconClassName }}>
			<div className={cn("flex flex-col gap-4", className)}>{children}</div>
		</IntegrationEmptyContext>
	)
}

/** One value-prop tile's copy — the shape config objects (e.g. scrape-target COPY) use. */
export interface IntegrationFeatureCopy {
	label: string
	title: string
	description: string
}

/**
 * The what-you-get row above the empty card: staggered grid of value-prop tiles.
 * Owns the entry wrappers (per-index delay) so tiles animate reliably no matter
 * where the `IntegrationEmptyFeature` children were rendered.
 */
export function IntegrationEmptyFeatures({ children }: { children: React.ReactNode }) {
	return (
		<ul className="grid grid-cols-1 gap-3 text-left sm:grid-cols-3">
			{Children.toArray(children).map((child, index) => (
				<li
					// Children.toArray prefixes existing keys; tiles are a static list, so this is stable.
					key={isValidElement(child) ? child.key : index}
					className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card px-4 py-3.5 animate-in fade-in slide-in-from-bottom-1 [animation-duration:300ms] motion-reduce:animate-none"
					style={{ animationDelay: `${50 + index * 50}ms`, animationFillMode: "backwards" }}
				>
					{child}
				</li>
			))}
		</ul>
	)
}

/** One value-prop tile: uppercase eyebrow, headline, one-line description. Informational only. */
export function IntegrationEmptyFeature({ label, title, description }: IntegrationFeatureCopy) {
	return (
		<>
			<span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
			<span className="text-base/5 font-semibold tracking-tight">{title}</span>
			<p className="text-xs/4 text-muted-foreground">{description}</p>
		</>
	)
}

/**
 * The dashed waiting-room card. Children compose freely — typically
 * `IntegrationEmptyMedia`, an `IntegrationEmptyHint`, the primary action
 * Button, and an `IntegrationEmptyFooter`; the gap handles spacing.
 */
export function IntegrationEmptyCard({
	className,
	children,
}: {
	className?: string
	children: React.ReactNode
}) {
	return (
		<div
			className={cn(
				"flex min-h-70 flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-input px-6 py-10 text-center",
				className,
			)}
		>
			{children}
		</div>
	)
}

/**
 * The fanned brand mark: two muted provider glyphs tilted behind a larger
 * brand-washed center plate, bottom-aligned like a hand of cards. Reads
 * icon/backerIcon/accent from `IntegrationEmpty`.
 */
export function IntegrationEmptyMedia() {
	const {
		icon: Icon,
		// Multicolor marks pass a monochrome twin here so the backers can actually dim;
		// everything else reuses the same glyph, which is what `text-muted-foreground/70`
		// already tints.
		backerIcon: BackerIcon = Icon,
		accent,
		iconClassName,
	} = useIntegrationEmptyContext("IntegrationEmptyMedia")
	// Slightly smaller, dimmer, and lower than the center plate — depth, not clutter.
	const backer =
		"absolute bottom-0.5 flex size-11 items-center justify-center rounded-[10px] border border-border/60 bg-muted text-muted-foreground/70 opacity-80"
	return (
		<div aria-hidden className="relative mb-1 flex h-16 shrink-0 items-end justify-center">
			<span className={cn(backer, "origin-bottom -translate-x-8 -rotate-10")}>
				<BackerIcon size={20} />
			</span>
			<span className={cn(backer, "origin-bottom translate-x-8 rotate-10")}>
				<BackerIcon size={20} />
			</span>
			<IntegrationIconPlate
				icon={Icon}
				accent={accent}
				iconClassName={iconClassName}
				size={28}
				plateClassName="relative size-14 rounded-xl shadow-lg shadow-black/10"
			/>
		</div>
	)
}

/** The one-line "what will appear here" promise. */
export function IntegrationEmptyHint({ children }: { children: React.ReactNode }) {
	return <p className="max-w-xl text-balance text-sm text-muted-foreground">{children}</p>
}

/** Quiet reassurance line under the action ("Read-only OAuth · takes about a minute · …"). */
export function IntegrationEmptyFooter({ children }: { children: React.ReactNode }) {
	return <p className="text-xs text-muted-foreground">{children}</p>
}
