import { useMemo, useState, type KeyboardEvent } from "react"
import Fuse, { type IFuseOptions } from "fuse.js"
import { Link } from "@tanstack/react-router"
import { useTheme } from "@maple/ui/hooks/use-theme"
import {
	Command,
	CommandDialog,
	CommandDialogPopup,
	CommandEmpty,
	CommandFooter,
	CommandGroup,
	CommandGroupLabel,
	CommandInput,
	CommandItem,
	CommandList,
	CommandShortcut,
} from "@maple/ui/components/ui/command"
import { Kbd } from "@maple/ui/components/ui/kbd"
import {
	ChatBubbleSparkleIcon,
	GearIcon,
	GridSquareCirclePlusIcon,
	KeyboardIcon,
	MoonIcon,
	SunIcon,
	UserIcon,
} from "@/components/icons"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { openGlobalChat } from "@/components/chat/global-chat-sheet"
import { paletteNavItems } from "@/components/dashboard/nav-items"
import { useDashboardPreferences } from "@/hooks/use-dashboard-preferences"
import { useDashboardsRead } from "@/hooks/use-dashboard-store"
import { useAtomValue } from "@/lib/effect-atom"
import { Result } from "@/lib/effect-atom"
import { getTracesFacetValuesResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { ServiceDot } from "@maple/ui/components/service-dot"

const MAX_RESULTS = 12

interface PaletteEntry {
	id: string
	title: string
	group: "Navigation" | "Services" | "Dashboards" | "Actions"
	keywords?: string
	icon?: typeof GearIcon
	/** Static route to navigate to (rendered as a router Link). */
	href?: string
	/** Dashboard id for /dashboards/$dashboardId entries. */
	dashboardId?: string
	/** Service name for /services/$serviceName entries (renders a ServiceDot). */
	serviceName?: string
	/** Imperative action (theme toggle, open shortcuts dialog, …). */
	run?: () => void
	/** Keyboard shortcut hint shown on the right edge of the row. */
	shortcut?: string
}

const FUSE_OPTIONS: IFuseOptions<PaletteEntry> = {
	keys: [
		{ name: "title", weight: 0.7 },
		{ name: "keywords", weight: 0.3 },
	],
	ignoreLocation: true,
	threshold: 0.35,
}

const GROUP_ORDER: ReadonlyArray<PaletteEntry["group"]> = ["Navigation", "Services", "Dashboards", "Actions"]

function groupEntries(entries: PaletteEntry[]): [PaletteEntry["group"], PaletteEntry[]][] {
	const groups = new Map<PaletteEntry["group"], PaletteEntry[]>()
	for (const entry of entries) {
		const list = groups.get(entry.group)
		if (list) list.push(entry)
		else groups.set(entry.group, [entry])
	}
	return [...groups.entries()].sort((a, b) => GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0]))
}

export interface CommandPaletteProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	onShowShortcuts: () => void
}

export function CommandPalette({ open, onOpenChange, onShowShortcuts }: CommandPaletteProps) {
	return (
		// Gate the popup on `open` so it unmounts cleanly — base-ui leaves the
		// backdrop mounted (pointer-events: auto) when the forced-open
		// Autocomplete inside holds focus through the close, blocking the page.
		<CommandDialog open={open} onOpenChange={onOpenChange}>
			{open && (
				<PaletteContent
					close={() => onOpenChange(false)}
					toggle={() => onOpenChange(!open)}
					onShowShortcuts={onShowShortcuts}
				/>
			)}
		</CommandDialog>
	)
}

function PaletteContent({
	close,
	toggle,
	onShowShortcuts,
}: {
	close: () => void
	toggle: () => void
	onShowShortcuts: () => void
}) {
	const [query, setQuery] = useState("")
	const { theme, setTheme } = useTheme()

	// These hooks live here (inside the open-gated popup) so the dashboards
	// query only fires once the palette is first opened.
	const { dashboards } = useDashboardsRead()
	const { favorites } = useDashboardPreferences()
	const servicesFacetResult = useAtomValue(getTracesFacetValuesResultAtom({ data: { facet: "service" } }))
	const serviceNames = Result.builder(servicesFacetResult)
		.onSuccess((r) => r.data.map((item) => item.name))
		.orElse(() => [])

	// The forced-open Autocomplete swallows Escape and ⌘K. Its parent popup sees
	// the capture phase first, so keep those actions in the event that caused them.
	const handleKeyDownCapture = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault()
			close()
		} else if ((event.key === "k" || event.key === "K") && (event.metaKey || event.ctrlKey)) {
			event.preventDefault()
			toggle()
		}
	}

	const entries = useMemo<PaletteEntry[]>(() => {
		// Sections *and* their children — Traces, Logs, Metrics, Replays, Hosts,
		// the K8s lists and the integration pages are all reachable by name here,
		// which is what lets the sidebar fold them into two sections.
		const navigation: PaletteEntry[] = [
			...paletteNavItems().map((item) => ({
				id: item.id,
				title: item.title,
				group: "Navigation" as const,
				keywords: `go to ${item.title}`,
				icon: item.icon,
				href: item.href,
			})),
			{
				id: "nav:/settings",
				title: "Settings",
				group: "Navigation",
				keywords: "go to settings preferences",
				icon: GearIcon,
				href: "/settings",
			},
			// `/account` redirects away in self-hosted mode, where there is no user record to manage.
			...(isClerkAuthEnabled
				? [
						{
							id: "nav:/account",
							title: "Account",
							group: "Navigation" as const,
							keywords:
								"account profile picture name password two-factor 2fa mfa passkey email security sessions devices",
							icon: UserIcon,
							href: "/account",
						},
					]
				: []),
		]

		const serviceEntries: PaletteEntry[] = serviceNames.map((name) => ({
			id: `service:${name}`,
			title: name,
			group: "Services" as const,
			keywords: `service ${name}`,
			serviceName: name,
		}))

		const favoriteDashboards = dashboards.filter((d) => favorites.has(d.id))
		const otherDashboards = dashboards.filter((d) => !favorites.has(d.id))
		const dashboardEntries: PaletteEntry[] = [...favoriteDashboards, ...otherDashboards].map(
			(dashboard) => ({
				id: `dashboard:${dashboard.id}`,
				title: dashboard.name,
				group: "Dashboards",
				keywords: "dashboard",
				icon: GridSquareCirclePlusIcon,
				dashboardId: dashboard.id,
			}),
		)

		const isDark = theme === "dark"
		const actions: PaletteEntry[] = [
			{
				id: "action:ask-maple-ai",
				title: "Ask Maple AI",
				group: "Actions",
				keywords: "chat ai assistant maple ask question",
				icon: ChatBubbleSparkleIcon,
				run: openGlobalChat,
				shortcut: "C",
			},
			{
				id: "action:toggle-theme",
				title: isDark ? "Switch to light mode" : "Switch to dark mode",
				group: "Actions",
				keywords: "theme dark light mode toggle appearance",
				icon: isDark ? SunIcon : MoonIcon,
				run: () => setTheme(isDark ? "light" : "dark"),
				shortcut: "T",
			},
			{
				id: "action:keyboard-shortcuts",
				title: "Keyboard shortcuts",
				group: "Actions",
				keywords: "help hotkeys keys bindings",
				icon: KeyboardIcon,
				run: onShowShortcuts,
				shortcut: "?",
			},
		]

		return [...navigation, ...serviceEntries, ...dashboardEntries, ...actions]
	}, [dashboards, favorites, serviceNames, theme, setTheme, onShowShortcuts])

	// Browse mode shows only a taste of the services list — the full set stays
	// searchable, but dozens of service rows shouldn't bury Dashboards/Actions.
	const browseEntries = useMemo(() => {
		let serviceCount = 0
		return entries.filter((entry) => entry.group !== "Services" || serviceCount++ < 5)
	}, [entries])
	const fuse = useMemo(() => new Fuse(entries, FUSE_OPTIONS), [entries])

	// `null` => browse mode (empty query); otherwise locally ranked hits.
	const results = useMemo<PaletteEntry[] | null>(() => {
		const trimmed = query.trim()
		if (!trimmed) return null
		return fuse.search(trimmed, { limit: MAX_RESULTS }).map(({ item }) => item)
	}, [fuse, query])

	const renderEntry = (entry: PaletteEntry) => {
		const content = (
			<>
				{entry.serviceName !== undefined ? (
					<ServiceDot serviceName={entry.serviceName} />
				) : entry.icon ? (
					<entry.icon size={16} className="shrink-0 text-muted-foreground" />
				) : null}
				<span className="truncate text-sm">{entry.title}</span>
				{entry.shortcut ? <CommandShortcut>{entry.shortcut}</CommandShortcut> : null}
			</>
		)
		if (entry.serviceName !== undefined) {
			const serviceName = entry.serviceName
			return (
				<CommandItem
					key={entry.id}
					value={entry.id}
					className="flex items-center gap-2"
					render={<Link to="/services/$serviceName" params={{ serviceName }} />}
					onClick={close}
				>
					{content}
				</CommandItem>
			)
		}
		if (entry.dashboardId !== undefined) {
			const dashboardId = entry.dashboardId
			return (
				<CommandItem
					key={entry.id}
					value={entry.id}
					className="flex items-center gap-2"
					render={<Link to="/dashboards/$dashboardId" params={{ dashboardId }} />}
					onClick={close}
				>
					{content}
				</CommandItem>
			)
		}
		if (entry.href !== undefined) {
			const href = entry.href
			return (
				<CommandItem
					key={entry.id}
					value={entry.id}
					className="flex items-center gap-2"
					render={<Link to={href} />}
					onClick={close}
				>
					{content}
				</CommandItem>
			)
		}
		return (
			<CommandItem
				key={entry.id}
				value={entry.id}
				className="flex items-center gap-2"
				onClick={() => {
					close()
					entry.run?.()
				}}
			>
				{content}
			</CommandItem>
		)
	}

	const grouped = groupEntries(results ?? browseEntries)

	return (
		<CommandDialogPopup onKeyDownCapture={handleKeyDownCapture}>
			<Command
				inline={false}
				filter={null}
				value={query}
				onValueChange={(value: string) => setQuery(value)}
			>
				<CommandInput placeholder="Search pages, dashboards, actions…" />
				<CommandList>
					{results !== null && results.length === 0 ? (
						<CommandEmpty>No results for “{query}”.</CommandEmpty>
					) : (
						grouped.map(([group, items]) => (
							<CommandGroup key={group}>
								<CommandGroupLabel>{group}</CommandGroupLabel>
								{items.map(renderEntry)}
							</CommandGroup>
						))
					)}
				</CommandList>
				<CommandFooter>
					<span className="flex items-center gap-1.5">
						<Kbd>↵</Kbd> to open
					</span>
					<span className="flex items-center gap-1.5">
						<Kbd>Esc</Kbd> to close
					</span>
				</CommandFooter>
			</Command>
		</CommandDialogPopup>
	)
}
