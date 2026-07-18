import { motion, useReducedMotion } from "motion/react"

import { Badge } from "@maple/ui/components/ui/badge"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"
import {
	CloudflareIcon,
	GithubIcon,
	HazelIcon,
	PlanetScaleIcon,
	PrometheusIcon,
	WarpStreamIcon,
} from "@/components/icons"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { scrapeTargetsListAtom } from "@/lib/services/atoms/scrape-target-atoms"

export type IntegrationId = "cloudflare" | "prometheus" | "planetscale" | "warpstream" | "hazel" | "github"

/**
 * Third-party brand accents for the icon-plate wash — no app token applies.
 * Owned here (catalog data) and consumed by the per-integration cards.
 */
export const GITHUB_ACCENT = "#181717"
export const HAZEL_ACCENT = "#F46F0F"
export const CLOUDFLARE_ACCENT = "#F38020"

export interface CatalogEntry {
	readonly id: IntegrationId
	readonly name: string
	readonly description: string
	readonly icon: React.ComponentType<{ size?: number; className?: string }>
	/** Brand accent for the icon plate wash (third-party colors, no app token applies). */
	readonly accent: string
	/**
	 * Class override for the icon glyph when the brand mark is monochrome and would
	 * vanish on the card at `accent` (e.g. GitHub's near-black). The wash still uses `accent`.
	 */
	readonly iconClassName?: string
	readonly docsUrl?: string
}

const CATALOG: ReadonlyArray<CatalogEntry> = [
	{
		id: "cloudflare",
		name: "Cloudflare",
		description:
			"Connect your Cloudflare account via OAuth — the foundation for one-click Workers telemetry.",
		icon: CloudflareIcon,
		accent: CLOUDFLARE_ACCENT,
	},
	{
		id: "prometheus",
		name: "Prometheus",
		description: "Scrape any Prometheus-compatible endpoint on a schedule — no collector required.",
		icon: PrometheusIcon,
		accent: "#E6522C",
		docsUrl: "https://maple.dev/docs/integrations/prometheus",
	},
	{
		id: "planetscale",
		name: "PlanetScale",
		description:
			"Authorize your organization with one click — Maple tracks every database branch automatically.",
		icon: PlanetScaleIcon,
		// PlanetScale's mark is monochrome — neutral wash that works in both themes.
		accent: "#8B8B8B",
		docsUrl: "https://maple.dev/docs/integrations/planetscale",
	},
	{
		id: "warpstream",
		name: "WarpStream",
		description: "Monitor WarpStream clusters via agent metrics or the hosted Prometheus endpoint.",
		icon: WarpStreamIcon,
		// WarpStream's brand crimson (fill of the official mark).
		accent: "#E52344",
		docsUrl: "https://maple.dev/docs/integrations/warpstream",
	},
	{
		id: "hazel",
		name: "Hazel",
		description:
			"Forward Maple alerts into a Hazel workspace via OAuth — pick destinations per notification.",
		icon: HazelIcon,
		accent: HAZEL_ACCENT,
		docsUrl: "https://hazel.sh/docs/integrations/maple",
	},
	{
		id: "github",
		name: "GitHub",
		description: "Install the Maple GitHub App to sync repositories and commits from your org.",
		icon: GithubIcon,
		accent: GITHUB_ACCENT,
		// GitHub's mark is near-black — render the glyph in the foreground token so it reads on the card.
		iconClassName: "text-foreground",
		docsUrl: "https://maple.dev/docs/integrations/github",
	},
]

export const catalogEntry = (id: IntegrationId): CatalogEntry => CATALOG.find((entry) => entry.id === id)!

interface CardStatus {
	readonly label: string
	readonly variant: "success" | "warning" | "error" | "outline"
}

const NOT_CONNECTED: CardStatus = { label: "Not connected", variant: "outline" }
// Status query failed — distinct from "Not connected" so a fetch error doesn't
// masquerade as a disconnected integration.
const STATUS_UNAVAILABLE: CardStatus = { label: "Status unavailable", variant: "outline" }

/**
 * Per-integration status derived purely from the list queries the drill-ins
 * already use — no per-target check fan-out at catalog level.
 */
export function useIntegrationStatuses(): Partial<Record<IntegrationId, CardStatus | null>> {
	const cloudflareAccountResult = useAtomValue(
		MapleApiAtomClient.query("integrations", "cloudflareStatus", {
			reactivityKeys: ["cloudflareIntegrationStatus"],
		}),
	)
	const scrapeResult = useAtomValue(scrapeTargetsListAtom)
	const planetscaleResult = useAtomValue(
		MapleApiAtomClient.query("integrations", "planetscaleStatus", {
			reactivityKeys: ["planetscaleIntegrationStatus"],
		}),
	)
	const hazelResult = useAtomValue(
		MapleApiAtomClient.query("integrations", "hazelStatus", {
			reactivityKeys: ["hazelIntegrationStatus"],
		}),
	)
	const githubResult = useAtomValue(
		MapleApiAtomClient.query("integrations", "githubStatus", {
			reactivityKeys: ["githubIntegrationStatus"],
		}),
	)

	const cloudflare: CardStatus | null = Result.builder(cloudflareAccountResult)
		.onSuccess(
			(status): CardStatus =>
				status.connected ? { label: "Connected", variant: "success" } : NOT_CONNECTED,
		)
		.onInitial(() => null)
		.orElse(() => STATUS_UNAVAILABLE)

	const scrapeStatus = (targetType: "prometheus" | "planetscale"): CardStatus | null =>
		Result.builder(scrapeResult)
			.onSuccess((response): CardStatus => {
				const targets = response.data.filter((target) => target.target_type === targetType)
				if (targets.length === 0) return NOT_CONNECTED
				const failing = targets.some((target) => target.enabled && target.last_scrape_error)
				const enabled = targets.filter((target) => target.enabled).length
				const noun = targetType === "planetscale" ? "org" : "target"
				return {
					label: `${targets.length} ${noun}${targets.length === 1 ? "" : "s"} · ${enabled} enabled`,
					variant: failing ? "warning" : "success",
				}
			})
			.onInitial(() => null)
			.orElse(() => STATUS_UNAVAILABLE)

	// First-class connection status; falls back to the scrape-target derivation for
	// orgs still on the manual (user-created target) escape hatch.
	const planetscale: CardStatus | null = Result.builder(planetscaleResult)
		.onSuccess((status): CardStatus | null => {
			if (!status.connected) return scrapeStatus("planetscale")
			const failing = status.scrapeTarget?.lastScrapeError != null
			return {
				label: status.organization ?? "Connected",
				variant: failing ? "warning" : "success",
			}
		})
		.onInitial(() => null)
		.orElse(() => STATUS_UNAVAILABLE)

	const hazel: CardStatus | null = Result.builder(hazelResult)
		.onSuccess(
			(status): CardStatus =>
				status.connected ? { label: "Connected", variant: "success" } : NOT_CONNECTED,
		)
		.onInitial(() => null)
		.orElse(() => STATUS_UNAVAILABLE)

	const github: CardStatus | null = Result.builder(githubResult)
		.onSuccess((status): CardStatus => {
			// Deactivated on GitHub's side (uninstalled / suspended) — the install row is
			// kept, so flag it for attention rather than showing a bare "Not connected".
			if (status.state === "disconnected") return { label: "Deactivated", variant: "warning" }
			if (status.state === "suspended") return { label: "Suspended", variant: "warning" }
			if (!status.connected) return NOT_CONNECTED
			// Count only active repos; provider-removed ones are shown in the card
			// with a re-enable/delete affordance, not as live synced repos.
			const count = status.repositories.filter((r) => r.status === "active").length
			return {
				label: count > 0 ? `${count} repo${count === 1 ? "" : "s"}` : "Connected",
				variant: "success",
			}
		})
		.onInitial(() => null)
		.orElse(() => STATUS_UNAVAILABLE)

	return {
		cloudflare,
		prometheus: scrapeStatus("prometheus"),
		planetscale,
		// WarpStream rides the generic Prometheus pipeline — no own target type.
		warpstream: { label: "Via Prometheus", variant: "outline" },
		hazel,
		github,
	}
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
 * The canonical integration icon tile: a bordered plate with a soft brand-accent
 * wash behind the glyph. Used by the catalog grid, the drill-in header, and the
 * per-integration cards so the tile is identical everywhere.
 */
export function IntegrationIconPlate({
	icon: Icon,
	accent,
	iconClassName,
	size = 22,
	plateClassName,
	overlay,
}: {
	icon: React.ComponentType<{ size?: number; className?: string }>
	/** Brand accent driving the wash (and the glyph, unless `iconClassName` overrides it). */
	accent: string
	/** Class override for the glyph color (e.g. `text-foreground` for monochrome marks). */
	iconClassName?: string
	size?: number
	/** Overrides the plate footprint + rounding (default `size-12 rounded-lg`). */
	plateClassName?: string
	/** Optional status marker pinned to the bottom-right of the plate. */
	overlay?: React.ReactNode
}) {
	return (
		<span
			className={cn(
				"relative inline-flex shrink-0 items-center justify-center border border-border/60 bg-card",
				plateClassName ?? "size-12 rounded-lg",
			)}
			style={{ ["--tile-accent" as string]: accent }}
			aria-hidden
		>
			<span
				className="absolute inset-0 rounded-[inherit] opacity-70"
				style={{
					// Brand-accent wash. Monochrome marks (iconClassName set, e.g. GitHub's near-black
					// #181717) are darker than the card and leave no visible wash on the dark canvas, so
					// derive theirs from --muted-foreground (warm-neutral, theme-aware) — the same visible
					// neutral bloom PlanetScale's gray accent already produces.
					background: iconClassName
						? "radial-gradient(circle at 30% 20%, color-mix(in srgb, var(--muted-foreground) 22%, transparent), transparent 70%)"
						: "radial-gradient(circle at 30% 20%, color-mix(in srgb, var(--tile-accent) 16%, transparent), transparent 70%)",
				}}
			/>
			<span
				className={cn("relative", iconClassName)}
				style={iconClassName ? undefined : { color: accent }}
			>
				<Icon size={size} />
			</span>
			{overlay}
		</span>
	)
}

export function IntegrationCatalog({ onSelect }: { onSelect: (id: IntegrationId) => void }) {
	const statuses = useIntegrationStatuses()
	const reduceMotion = useReducedMotion()

	return (
		<motion.div
			// 3 columns only at 2xl — the page nests under two sidebars, so the content
			// region is far narrower than the viewport; at xl, 3 cols crush the names.
			className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3"
			variants={GRID_VARIANTS}
			// Reduced motion: render the cards in place with no staggered transform.
			initial={reduceMotion ? false : "hidden"}
			animate="show"
		>
			{CATALOG.map((entry) => {
				const status = statuses[entry.id]
				return (
					<motion.button
						key={entry.id}
						type="button"
						variants={ITEM_VARIANTS}
						onClick={() => onSelect(entry.id)}
						className="group flex items-start gap-4 rounded-lg border border-border/60 bg-card p-4 text-left outline-none transition-colors hover:border-border hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
					>
						<IntegrationIconPlate
							icon={entry.icon}
							accent={entry.accent}
							iconClassName={entry.iconClassName}
						/>
						<span className="flex min-w-0 flex-1 flex-col gap-1">
							<span className="flex items-center justify-between gap-2">
								<span className="truncate text-sm font-semibold">{entry.name}</span>
								{status === null || status === undefined ? (
									<Skeleton className="h-5 w-20 shrink-0 rounded-full" />
								) : (
									<Badge variant={status.variant} className="shrink-0">
										{status.label}
									</Badge>
								)}
							</span>
							<span className="text-xs text-muted-foreground">{entry.description}</span>
						</span>
					</motion.button>
				)
			})}
		</motion.div>
	)
}
