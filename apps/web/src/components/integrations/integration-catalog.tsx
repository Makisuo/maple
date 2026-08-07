import { Badge } from "@maple/ui/components/ui/badge"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"
import {
	ChevronRightIcon,
	CloudflareIcon,
	GithubIcon,
	HazelIcon,
	PlanetScaleIcon,
	PrometheusIcon,
	SlackIcon,
	WarpStreamIcon,
} from "@/components/icons"
import { PLANETSCALE_COLOR } from "@/components/infra/planetscale/metrics"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { scrapeTargetsListAtom } from "@/lib/services/atoms/scrape-target-atoms"

export type IntegrationId =
	| "cloudflare"
	| "prometheus"
	| "planetscale"
	| "warpstream"
	| "hazel"
	| "github"
	| "slack"

/**
 * Third-party brand accents for the icon-plate wash — no app token applies.
 * Owned here (catalog data) and consumed by the per-integration cards.
 */
export const GITHUB_ACCENT = "#181717"
export const HAZEL_ACCENT = "#F46F0F"
export const CLOUDFLARE_ACCENT = "#F38020"

/**
 * Slack's deep aubergine — the brand's identity color, and the light-theme value.
 * It is oklch(0.267), i.e. *darker* than the dark `--card` (oklch 0.224), so every
 * accent consumer collapses on the dark canvas: the 16% plate wash below lands at
 * 1.01:1 against the card, and the destination picker's 1.5px selected ring at
 * 1.23:1. On light it is 14:1 against the card — keep it there.
 */
export const SLACK_ACCENT_ON_LIGHT = "#4A154B"
/**
 * Dark-canvas stand-in: the same aubergine hue lifted onto the dark canvas —
 * oklch(0.58 0.16 330) against the brand's oklch(0.267 0.107 328), so it still
 * reads as Slack purple rather than a new brand color. It takes the selected ring
 * to 3.68:1 (over the 3:1 bar for non-text UI) and the wash to ΔL 0.042 in oklab,
 * 6× the aubergine's 0.007 and two thirds of the GitHub neutral fallback's 0.065.
 *
 * Not the mark's sky blue (#36C5F0), tempting as its 8.5:1 ring is: `accent` also
 * paints the destination dialog's save button, which hard-codes white label text —
 * the blue drops that to 2.0:1, while this holds 4.65:1.
 */
export const SLACK_ACCENT_ON_DARK = "#AD51A7"
/**
 * `light-dark()` resolves against the `color-scheme` the theme hook pins on the
 * root element, so one constant covers both canvases wherever a raw brand color
 * is expected. Consumers must combine it with `color-mix()`, never hex-alpha
 * concatenation.
 */
export const SLACK_ACCENT = `light-dark(${SLACK_ACCENT_ON_LIGHT}, ${SLACK_ACCENT_ON_DARK})`

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
		accent: PLANETSCALE_COLOR,
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
	{
		id: "slack",
		name: "Slack",
		description:
			"Install the Maple Slack app — ask Maple questions, create dashboards, and route alerts to channels.",
		icon: SlackIcon,
		// Theme-aware by construction (see SLACK_ACCENT). The `iconClassName` escape
		// hatch GitHub uses can't help here: Slack's mark is multicolor, so tinting
		// the glyph via className does nothing — the accent itself has to move.
		accent: SLACK_ACCENT,
		docsUrl: "https://maple.dev/docs/integrations/slack",
	},
]

export const catalogEntry = (id: IntegrationId): CatalogEntry => CATALOG.find((entry) => entry.id === id)!

/**
 * Whether a value names an integration in the catalog. External OAuth callbacks
 * redirect back with `?integration=<id>`, so the id arrives as untrusted input
 * and has to be narrowed before it reaches `catalogEntry`.
 */
export const isIntegrationId = (value: string): value is IntegrationId =>
	CATALOG.some((entry) => entry.id === value)

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
		MapleApiV2AtomClient.query("planetscaleIntegration", "status", {
			reactivityKeys: ["planetscaleIntegration"],
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
	const slackResult = useAtomValue(
		MapleApiV2AtomClient.query("slackIntegration", "status", {
			reactivityKeys: ["slackIntegration"],
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
			const failing = status.scrape_target?.last_scrape_error != null
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

	const slack: CardStatus | null = Result.builder(slackResult)
		.onSuccess(
			(status): CardStatus =>
				status.installed
					? { label: status.team_name ?? "Connected", variant: "success" }
					: NOT_CONNECTED,
		)
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
		slack,
	}
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

// ---------------------------------------------------------------------------
// Overview model — the dense connected-row / available-card split. Derived from
// the same list queries as `useIntegrationStatuses` (plus the cheap PlanetScale
// inventory read); deliberately NO warehouse queries at hub level.
// ---------------------------------------------------------------------------

interface ConnectedOverview {
	readonly kind: "connected"
	readonly health: "healthy" | "attention"
	/** Short state word next to the health dot ("Healthy", "Needs attention", "Suspended"). */
	readonly stateLabel: string
	/** Second line under the name ("Acme Corp", "@acme-corp · GitHub App"). */
	readonly context: string | null
	/** Headline stat ("12 repos synced", "2 of 3 targets enabled"). */
	readonly stat: string | null
	/** "synced 2m ago" — null when the integration has no sync concept (Hazel). */
	readonly lastSyncLabel: string | null
	/** Warning chip ("1 zone erroring") — presence implies `health: "attention"` visuals. */
	readonly issue: string | null
}

interface AvailableOverview {
	readonly kind: "available"
	/** CTA verb: "Connect" for OAuth flows, "Set up" for DIY/scrape flows. */
	readonly cta: "Connect" | "Set up"
}

interface UnavailableOverview {
	readonly kind: "unavailable"
}

/** `null` = status query still loading. */
export type IntegrationOverview = ConnectedOverview | AvailableOverview | UnavailableOverview | null

const CONNECT: AvailableOverview = { kind: "available", cta: "Connect" }
const SET_UP: AvailableOverview = { kind: "available", cta: "Set up" }
const UNAVAILABLE: UnavailableOverview = { kind: "unavailable" }

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

const syncedLabel = (ms: number | null | undefined, verb = "synced"): string | null =>
	ms == null ? null : `${verb} ${formatRelativeTime(new Date(ms).toISOString())}`

const maxMs = (values: ReadonlyArray<number | null | undefined>): number | null =>
	values.reduce<number | null>((acc, v) => (v != null && (acc === null || v > acc) ? v : acc), null)

export function useIntegrationOverviews(): Record<IntegrationId, IntegrationOverview> {
	const cloudflareResult = useAtomValue(
		MapleApiAtomClient.query("integrations", "cloudflareStatus", {
			reactivityKeys: ["cloudflareIntegrationStatus"],
		}),
	)
	const scrapeResult = useAtomValue(scrapeTargetsListAtom)
	const planetscaleResult = useAtomValue(
		MapleApiV2AtomClient.query("planetscaleIntegration", "status", {
			reactivityKeys: ["planetscaleIntegration"],
		}),
	)
	// Poller-inventory read (no warehouse) — feeds the "N databases tracked" stat.
	const planetscaleDbResult = useAtomValue(
		MapleApiV2AtomClient.query("planetscaleIntegration", "databases", {
			reactivityKeys: ["planetscaleIntegration"],
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
	const slackResult = useAtomValue(
		MapleApiV2AtomClient.query("slackIntegration", "status", {
			reactivityKeys: ["slackIntegration"],
		}),
	)

	const cloudflare: IntegrationOverview = Result.builder(cloudflareResult)
		.onSuccess((status): IntegrationOverview => {
			if (!status.connected) return CONNECT
			const zones = status.zones
			const enabledZones = zones.filter((z) => z.enabled).length
			const erroringZones = zones.filter((z) => z.enabled && z.lastError != null).length
			const workersFailing = status.workers?.enabled === true && status.workers.lastError != null
			const issue = !status.analyticsCapable
				? "Update access"
				: erroringZones > 0
					? `${plural(erroringZones, "zone")} erroring`
					: workersFailing
						? "Workers sync failing"
						: null
			const statParts =
				zones.length > 0 ? [`${enabledZones} of ${plural(zones.length, "zone")} streaming`] : []
			if (status.workers?.enabled) statParts.push("Workers")
			return {
				kind: "connected",
				health: issue ? "attention" : "healthy",
				stateLabel: issue ? "Needs attention" : "Healthy",
				context: status.accountName,
				stat: statParts.length > 0 ? statParts.join(" · ") : null,
				lastSyncLabel: syncedLabel(
					maxMs([...zones.map((z) => z.lastSyncedAt), status.workers?.lastSyncedAt]),
				),
				issue,
			}
		})
		.onInitial(() => null)
		.orElse(() => UNAVAILABLE)

	const scrapeOverview = (targetType: "prometheus" | "planetscale"): IntegrationOverview =>
		Result.builder(scrapeResult)
			.onSuccess((response): IntegrationOverview => {
				const targets = response.data.filter((target) => target.target_type === targetType)
				if (targets.length === 0) return targetType === "prometheus" ? SET_UP : CONNECT
				const enabled = targets.filter((target) => target.enabled).length
				const failing = targets.filter(
					(target) => target.enabled && target.last_scrape_error != null,
				).length
				const noun = targetType === "planetscale" ? "org" : "target"
				return {
					kind: "connected",
					health: failing > 0 ? "attention" : "healthy",
					stateLabel: failing > 0 ? "Needs attention" : "Healthy",
					context: plural(targets.length, `scrape ${noun}`),
					stat: `${enabled} of ${targets.length} enabled`,
					lastSyncLabel: syncedLabel(
						maxMs(targets.map((t) => (t.last_scrape_at ? Date.parse(t.last_scrape_at) : null))),
						"scraped",
					),
					issue: failing > 0 ? `${plural(failing, noun)} failing` : null,
				}
			})
			.onInitial(() => null)
			.orElse(() => UNAVAILABLE)

	const planetscaleDbCount: number | null = Result.builder(planetscaleDbResult)
		.onSuccess((response): number | null => response.databases.length)
		.onInitial((): number | null => null)
		.orElse((): number | null => null)

	const planetscale: IntegrationOverview = Result.builder(planetscaleResult)
		.onSuccess((status): IntegrationOverview => {
			// Manual (user-created scrape target) escape hatch — derive from targets.
			if (!status.connected) return scrapeOverview("planetscale")
			const issue = status.pending_org_selection
				? "Finish org selection"
				: status.metrics_auth === "missing"
					? "Metrics setup pending"
					: status.scrape_target?.last_scrape_error != null
						? "Scrape failing"
						: status.last_inventory_error != null
							? "Inventory failing"
							: null
			return {
				kind: "connected",
				health: issue ? "attention" : "healthy",
				stateLabel: issue ? "Needs attention" : "Healthy",
				context: status.organization,
				stat:
					planetscaleDbCount != null && planetscaleDbCount > 0
						? `${plural(planetscaleDbCount, "database")} tracked`
						: status.scrape_target?.enabled
							? "Metrics scraping on"
							: null,
				lastSyncLabel: syncedLabel(
					maxMs(
						[status.scrape_target?.last_scrape_at, status.last_inventory_at].map((iso) =>
							iso ? Date.parse(iso) : null,
						),
					),
				),
				issue,
			}
		})
		.onInitial(() => null)
		.orElse(() => UNAVAILABLE)

	const hazel: IntegrationOverview = Result.builder(hazelResult)
		.onSuccess(
			(status): IntegrationOverview =>
				status.connected
					? {
							kind: "connected",
							health: "healthy",
							stateLabel: "Healthy",
							context: status.externalUserEmail,
							stat: "Alert delivery ready",
							// Hazel has no sync loop — deliveries are push-per-alert.
							lastSyncLabel: null,
							issue: null,
						}
					: CONNECT,
		)
		.onInitial(() => null)
		.orElse(() => UNAVAILABLE)

	const github: IntegrationOverview = Result.builder(githubResult)
		.onSuccess((status): IntegrationOverview => {
			if (status.state === "disconnected")
				return {
					kind: "connected",
					health: "attention",
					stateLabel: "Deactivated",
					context: status.accountLogin ? `@${status.accountLogin} · GitHub App` : "GitHub App",
					stat: null,
					lastSyncLabel: null,
					issue: "Reinstall the app",
				}
			if (status.state === "suspended")
				return {
					kind: "connected",
					health: "attention",
					stateLabel: "Suspended",
					context: status.accountLogin ? `@${status.accountLogin} · GitHub App` : "GitHub App",
					stat: null,
					lastSyncLabel: null,
					issue: "Suspended on GitHub",
				}
			if (!status.connected) return CONNECT
			const active = status.repositories.filter((r) => r.status === "active")
			const removed = status.repositories.length - active.length
			const failing = active.filter((r) => r.lastSyncError != null).length
			const issue =
				failing > 0
					? `${plural(failing, "repo")} failing`
					: removed > 0
						? `${plural(removed, "repo")} removed`
						: null
			return {
				kind: "connected",
				health: issue ? "attention" : "healthy",
				stateLabel: issue ? "Needs attention" : "Healthy",
				context: status.accountLogin ? `@${status.accountLogin} · GitHub App` : "GitHub App",
				stat: active.length > 0 ? `${plural(active.length, "repo")} synced` : null,
				lastSyncLabel: syncedLabel(maxMs(active.map((r) => r.lastSyncedAt))),
				issue,
			}
		})
		.onInitial(() => null)
		.orElse(() => UNAVAILABLE)

	const slack: IntegrationOverview = Result.builder(slackResult)
		.onSuccess(
			(status): IntegrationOverview =>
				status.installed
					? {
							kind: "connected",
							health: "healthy",
							stateLabel: "Healthy",
							context: status.team_name ?? null,
							stat: "Alerts & agent ready",
							// Slack has no sync loop — messages are push-per-alert/query.
							lastSyncLabel: null,
							issue: null,
						}
					: CONNECT,
		)
		.onInitial(() => null)
		.orElse(() => UNAVAILABLE)

	return {
		cloudflare,
		prometheus: scrapeOverview("prometheus"),
		planetscale,
		// WarpStream rides the generic Prometheus pipeline — always a set-up card.
		warpstream: SET_UP,
		hazel,
		github,
		slack,
	}
}

/**
 * Fleet summary chips ("4 connected · 2 need attention") — rendered by the route
 * in the header bar. Shares atoms with the catalog, so no duplicate fetches.
 */
export function IntegrationsSummary() {
	const overviews = useIntegrationOverviews()
	const values = CATALOG.map((entry) => overviews[entry.id])
	// Quiet until everything resolved — a partial count would be wrong.
	if (values.some((value) => value === null)) return null
	const connected = values.filter((value): value is ConnectedOverview => value?.kind === "connected")
	if (connected.length === 0) return null
	const attention = connected.filter((value) => value.health === "attention").length
	return (
		<div className="flex items-center gap-2">
			<span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 px-2.5 py-0.5 text-xs text-muted-foreground">
				<span className="size-1.5 rounded-full bg-success" aria-hidden />
				{connected.length} connected
			</span>
			{attention > 0 && (
				<span className="inline-flex items-center gap-1.5 rounded-full border border-warning/25 bg-warning/10 px-2.5 py-0.5 text-xs text-warning-foreground">
					<span className="size-1.5 rounded-full bg-warning" aria-hidden />
					{attention} need attention
				</span>
			)}
		</div>
	)
}

function HealthDot({ health }: { health: "healthy" | "attention" | "unavailable" }) {
	return (
		<span
			aria-hidden
			className={cn(
				"size-1.5 shrink-0 rounded-full",
				health === "healthy" && "bg-success",
				health === "attention" && "bg-warning",
				health === "unavailable" && "bg-muted-foreground",
			)}
		/>
	)
}

function ConnectedRow({
	entry,
	overview,
	onSelect,
}: {
	entry: CatalogEntry
	overview: ConnectedOverview | UnavailableOverview
	onSelect: (id: IntegrationId) => void
}) {
	const connected = overview.kind === "connected" ? overview : null
	return (
		<button
			type="button"
			onClick={() => onSelect(entry.id)}
			className="group flex w-full items-center gap-4 px-4 py-3 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
		>
			<IntegrationIconPlate
				icon={entry.icon}
				accent={entry.accent}
				iconClassName={entry.iconClassName}
				plateClassName="size-8 rounded-lg"
				size={18}
			/>
			<span className="flex w-44 min-w-0 shrink-0 flex-col gap-0.5 2xl:w-52">
				<span className="truncate text-sm font-semibold">{entry.name}</span>
				{connected?.context && (
					<span className="truncate text-xs text-muted-foreground">{connected.context}</span>
				)}
			</span>
			<span className="flex w-28 shrink-0 items-center gap-2">
				<HealthDot health={connected?.health ?? "unavailable"} />
				<span className="truncate text-xs">{connected?.stateLabel ?? "Status unavailable"}</span>
			</span>
			{connected?.stat && (
				<span className="hidden min-w-0 flex-1 truncate text-sm text-foreground/90 md:block">
					{connected.stat}
				</span>
			)}
			<span className="ml-auto flex shrink-0 items-center gap-3">
				{connected?.lastSyncLabel && (
					<span className="hidden w-28 text-right text-xs text-muted-foreground 2xl:block">
						{connected.lastSyncLabel}
					</span>
				)}
				{connected?.issue && (
					<Badge variant="warning" size="sm" className="hidden sm:inline-flex">
						{connected.issue}
					</Badge>
				)}
				<ChevronRightIcon
					size={14}
					className="text-muted-foreground/70 transition-colors group-hover:text-foreground"
				/>
			</span>
		</button>
	)
}

function AvailableCard({
	entry,
	cta,
	onSelect,
}: {
	entry: CatalogEntry
	cta: "Connect" | "Set up"
	onSelect: (id: IntegrationId) => void
}) {
	return (
		<button
			type="button"
			onClick={() => onSelect(entry.id)}
			className="group flex items-center gap-4 rounded-lg border border-border/60 bg-card p-4 text-left outline-none transition-colors hover:border-border hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
		>
			<IntegrationIconPlate
				icon={entry.icon}
				accent={entry.accent}
				iconClassName={entry.iconClassName}
				plateClassName="size-9 rounded-lg"
				size={20}
			/>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="truncate text-sm font-semibold">{entry.name}</span>
				<span className="line-clamp-2 text-xs text-muted-foreground">{entry.description}</span>
			</span>
			{/* Styled as a button, but the whole card is the interactive element. */}
			<span
				className={cn(
					"shrink-0 rounded-md border border-input px-3 py-1.5 text-xs font-medium transition-colors group-hover:border-ring/60",
					cta === "Connect" ? "text-primary" : "text-foreground",
				)}
			>
				{cta} →
			</span>
		</button>
	)
}

function SkeletonRow() {
	return (
		<div className="flex w-full items-center gap-4 px-4 py-3">
			<Skeleton className="size-8 shrink-0 rounded-lg" />
			<span className="flex w-52 shrink-0 flex-col gap-1.5">
				<Skeleton className="h-3.5 w-24" />
				<Skeleton className="h-3 w-32" />
			</span>
			<Skeleton className="h-3 w-20" />
		</div>
	)
}

function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
			{children}
		</span>
	)
}

export function IntegrationCatalog({ onSelect }: { onSelect: (id: IntegrationId) => void }) {
	const overviews = useIntegrationOverviews()

	const connected = CATALOG.flatMap((entry) => {
		const overview = overviews[entry.id]
		return overview !== null && (overview.kind === "connected" || overview.kind === "unavailable")
			? [{ entry, overview }]
			: []
	})
	const available = CATALOG.flatMap((entry) => {
		const overview = overviews[entry.id]
		return overview !== null && overview.kind === "available" ? [{ entry, overview }] : []
	})
	const loading = CATALOG.filter((entry) => overviews[entry.id] === null)

	return (
		<div className="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-1 [animation-duration:300ms] motion-reduce:animate-none">
			{(connected.length > 0 || loading.length > 0) && (
				<section className="flex flex-col gap-2">
					<SectionLabel>Connected</SectionLabel>
					<div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60 bg-card">
						{connected.map(({ entry, overview }) => (
							<ConnectedRow
								key={entry.id}
								entry={entry}
								overview={overview}
								onSelect={onSelect}
							/>
						))}
						{loading.map((entry) => (
							<SkeletonRow key={entry.id} />
						))}
					</div>
				</section>
			)}
			{available.length > 0 && (
				<section className="flex flex-col gap-2">
					<SectionLabel>Available</SectionLabel>
					<div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
						{available.map(({ entry, overview }) => (
							<AvailableCard
								key={entry.id}
								entry={entry}
								cta={overview.cta}
								onSelect={onSelect}
							/>
						))}
					</div>
				</section>
			)}
		</div>
	)
}
