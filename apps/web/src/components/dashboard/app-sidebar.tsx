import { memo, useMemo } from "react"
import { Link, useRouterState } from "@tanstack/react-router"
import { useUser, useClerk } from "@clerk/clerk-react"
import {
	CircleQuestionIcon,
	DiscordIcon,
	EnvelopeIcon,
	GearIcon,
	GridSquareCirclePlusIcon,
	KeyboardIcon,
	LogoutIcon,
	CompassIcon,
	MagnifierIcon,
	UserIcon,
} from "@/components/icons"
import {
	isNavItemActive,
	isPathActive,
	navGroups,
	partitionInfraSubItems,
	type NavGroup,
	type NavItem,
	type NavSubItem,
	type NavSurface,
} from "@/components/dashboard/nav-items"
import { openCommandPalette, showKeyboardShortcuts } from "@/components/command-palette/global-shortcuts"
import { OrgSwitcher } from "@/components/dashboard/org-switcher"
import { UserAvatar, userInitials } from "@/components/dashboard/user-avatar"
import { ThemeToggle } from "@/components/dashboard/theme-toggle"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuBadge,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
	useSidebar,
} from "@maple/ui/components/ui/sidebar"
import { Badge } from "@maple/ui/components/ui/badge"
import { Kbd } from "@maple/ui/components/ui/kbd"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { clearSelfHostedSessionToken } from "@/lib/services/common/self-hosted-auth"
import { useDashboardsRead } from "@/hooks/use-dashboard-store"
import { useDashboardPreferences } from "@/hooks/use-dashboard-preferences"
import { useOrganizationFeatureFlags } from "@/hooks/use-organization-feature-flags"
import { useInfraSurfaces } from "@/hooks/use-infra-surfaces"

/**
 * A 2px lane is reserved on every row so icons share one vertical line whether
 * or not the row is selected — only the active row paints it. Squaring the left
 * corners is what makes it read as a rail against the sidebar edge rather than
 * a rounded sliver floating inside the pill. `--sidebar-primary` was defined in
 * tokens.css and consumed by nothing before this; it is the one thing that
 * distinguishes "selected" from "hovered", which otherwise share a fill.
 */
const RAIL_LANE = "relative before:absolute before:inset-y-0 before:left-0 before:w-0.5"
const ACTIVE_RAIL = `${RAIL_LANE} data-[active=true]:rounded-l-none data-[active=true]:before:bg-sidebar-primary data-[active=true]:text-sidebar-primary`

/** Group labels sit below the items they name, not level with them. */
const GROUP_LABEL = "h-6 text-muted-foreground"

/** Beyond this the Pinned list stops being a shortcut and becomes a second list. */
const MAX_PINNED = 5

function UserMenu() {
	const { user } = useUser()
	const { signOut } = useClerk()

	const name = user?.fullName ?? "User"
	const email = user?.primaryEmailAddress?.emailAddress ?? ""
	const imageUrl = user?.imageUrl
	const initials = userInitials(name)

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<SidebarMenuButton
						className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
						tooltip={name}
					/>
				}
			>
				<UserAvatar imageUrl={imageUrl} initials={initials} name={name} />
				<span className="truncate font-medium">{name}</span>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="min-w-56" side="top" sideOffset={4}>
				<DropdownMenuGroup>
					<DropdownMenuLabel>
						<div className="flex items-center gap-2 py-1 text-left text-sm">
							<UserAvatar
								className="size-8 rounded-md text-xs"
								imageUrl={imageUrl}
								initials={initials}
								name={name}
							/>
							<div className="grid flex-1 text-left text-sm leading-tight">
								<span className="truncate font-medium">{name}</span>
								{email && (
									<span className="truncate text-muted-foreground text-xs">{email}</span>
								)}
							</div>
						</div>
					</DropdownMenuLabel>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<ThemeToggle />
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuItem render={<Link to="/account" />}>
						<UserIcon size={16} />
						Account
					</DropdownMenuItem>
					<DropdownMenuItem render={<Link to="/settings" />}>
						<GearIcon size={16} />
						Settings
					</DropdownMenuItem>
					<DropdownMenuItem onClick={showKeyboardShortcuts}>
						<KeyboardIcon size={16} />
						Keyboard shortcuts
						<DropdownMenuShortcut>?</DropdownMenuShortcut>
					</DropdownMenuItem>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuItem onClick={() => signOut()}>
						<LogoutIcon size={16} />
						Log out
					</DropdownMenuItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function handleGuestLogout() {
	clearSelfHostedSessionToken()
	window.location.assign("/sign-in")
}

function GuestMenu() {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<SidebarMenuButton
						className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
						tooltip="Root"
					/>
				}
			>
				<UserAvatar initials="RT" name="Root" />
				<span className="truncate font-medium">Root</span>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="min-w-56" side="top" sideOffset={4}>
				<DropdownMenuGroup>
					<ThemeToggle />
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuItem render={<Link to="/settings" />}>
						<GearIcon size={16} />
						Settings
					</DropdownMenuItem>
					<DropdownMenuItem onClick={showKeyboardShortcuts}>
						<KeyboardIcon size={16} />
						Keyboard shortcuts
						<DropdownMenuShortcut>?</DropdownMenuShortcut>
					</DropdownMenuItem>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuItem onClick={handleGuestLogout}>
						<LogoutIcon size={16} />
						Log out
					</DropdownMenuItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

/**
 * ⌘K is the escape hatch that lets the nav stay short, so it needs to be
 * visible rather than folklore. Collapses to the magnifier alone on the rail.
 */
function SearchRow() {
	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<SidebarMenuButton
					className="border border-sidebar-border bg-background text-muted-foreground hover:bg-background hover:text-foreground"
					onClick={openCommandPalette}
					tooltip="Search"
				>
					<MagnifierIcon size={16} />
					<span className="flex-1 text-left">Search</span>
					<Kbd className="group-data-[collapsible=icon]:hidden">⌘K</Kbd>
				</SidebarMenuButton>
			</SidebarMenuItem>
		</SidebarMenu>
	)
}

function NavRow({
	item,
	currentPath,
	surfaces,
}: {
	item: NavItem
	currentPath: string
	/** What the org has; `null` until known. See `partitionInfraSubItems`. */
	surfaces: ReadonlySet<NavSurface> | null
}) {
	const { state, isMobile } = useSidebar()
	const isActive = isNavItemActive(currentPath, item)
	const collapsed = state === "collapsed" && !isMobile

	// Applied to every section, not just Infrastructure: a section whose children
	// carry no `surface` comes back whole, so there is nothing to special-case.
	const discoverTo = item.discoverTo
	const { shown, hidden } = useMemo(
		() =>
			item.subItems
				? partitionInfraSubItems(item.subItems, surfaces, currentPath)
				: { shown: [], hidden: [] },
		[item.subItems, surfaces, currentPath],
	)
	const subItems = item.subItems ? shown : undefined

	// Longest match wins: Infrastructure's Hosts child is `/infra`, which
	// prefixes every one of its siblings, so a plain match would light up two
	// rows on /infra/kubernetes/pods.
	// The discover page lives under the section's own href, so it would otherwise
	// light up the child that owns the section root — Hosts is `/infra`, and
	// `/infra/discover` prefixes it. It's a sibling row here, not a child, so it
	// takes the selection off them entirely.
	const discoverActive = discoverTo ? isPathActive(currentPath, discoverTo) : false

	const activeSubHref = useMemo(() => {
		if (discoverActive) return undefined
		let best: string | undefined
		for (const sub of subItems ?? []) {
			if (!isPathActive(currentPath, sub.href)) continue
			if (best === undefined || sub.href.length > best.length) best = sub.href
		}
		return best
	}, [subItems, currentPath, discoverActive])

	// While a section is open the rail belongs to the child you're actually on,
	// not the parent — otherwise two amber bars compete and neither points at
	// the current page. The open parent keeps the fill.
	const isOpen = Boolean(subItems && subItems.length > 0 && isActive)

	// A closed section is a word with its contents hidden behind it: "Explore"
	// doesn't say traces/logs/metrics/replays. Trailing miniatures of the
	// children's own glyphs say it without spending four rows. Only drawn when
	// every child has a mark — a partial run reads as a broken list — and
	// dropped once the section opens and the real rows are on screen. Repeated
	// marks collapse to one: Infrastructure's three k8s pages share a glyph, and
	// drawing it three times both crowds the label and overstates the variety.
	const preview = useMemo(() => {
		if (isOpen || !subItems?.every((sub) => sub.icon)) return undefined
		const seen = new Set<NavSubItem["icon"]>()
		const unique: NavSubItem[] = []
		for (const sub of subItems) {
			if (!sub.icon || seen.has(sub.icon)) continue
			seen.add(sub.icon)
			unique.push(sub)
		}
		// Truncating by position would silently drop whichever brand lands last
		// — the same partial-run problem as the every-child guard above — so the
		// preview is all or nothing. Five fits both sections we ship (Explore
		// with Agent Sessions on, Infrastructure) at the tightened gap below.
		return unique.length > 5 ? undefined : unique
	}, [isOpen, subItems])

	// The sub-list can't render at 48px, so the rail turns the row into a menu.
	// Without this, every child route is stranded while the sidebar is collapsed
	// — which is the state Infrastructure ships in today.
	if (collapsed && subItems && subItems.length > 0) {
		return (
			<SidebarMenuItem>
				<DropdownMenu>
					<DropdownMenuTrigger
						render={<SidebarMenuButton className={ACTIVE_RAIL} isActive={isActive} />}
					>
						<item.icon size={18} />
						<span>{item.title}</span>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="min-w-44" side="right" sideOffset={4}>
						<DropdownMenuGroup>
							<DropdownMenuLabel>{item.title}</DropdownMenuLabel>
							{subItems.map((sub) => (
								<DropdownMenuItem key={sub.title} render={<Link to={sub.href} />}>
									{sub.icon ? (
										<sub.icon size={16} style={{ color: sub.iconColor }} />
									) : null}
									{sub.title}
								</DropdownMenuItem>
							))}
						</DropdownMenuGroup>
						{/* The rail's menu is transient and costs no standing space, so
						    everything the section owns is reachable here — the pruning
						    exists to shorten a list you look at, not to lock pages away.
						    This is also the only nav the collapsed rail has, so a source
						    the probe got wrong must still be one click away. */}
						{hidden.length > 0 ? (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuGroup>
									{hidden.map((sub) => (
										<DropdownMenuItem
											key={sub.title}
											render={<Link to={sub.href} />}
										>
											{sub.icon ? (
												<sub.icon
													size={16}
													style={{ color: sub.iconColor }}
												/>
											) : null}
											{sub.title}
										</DropdownMenuItem>
									))}
									{discoverTo ? (
										<DropdownMenuItem render={<Link to={discoverTo} />}>
											<CompassIcon size={16} />
											Discover more
										</DropdownMenuItem>
									) : null}
								</DropdownMenuGroup>
							</>
						) : null}
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarMenuItem>
		)
	}

	return (
		<SidebarMenuItem>
			<SidebarMenuButton
				className={isOpen ? RAIL_LANE : ACTIVE_RAIL}
				isActive={isActive}
				render={<Link to={item.href} />}
				tooltip={item.title}
			>
				<item.icon size={18} />
				<span className="flex-1 truncate">{item.title}</span>
				{preview ? (
					// Brand marks keep their own color here — Kubernetes blue and
					// Cloudflare orange hardcode their fill, PlanetScale takes the tint —
					// so the cluster is recognisable at 12px instead of four grey smudges.
					// Non-brand children (Explore's signals, Hosts) stay muted.
					<span className="flex shrink-0 items-center gap-1 text-muted-foreground group-data-[collapsible=icon]:hidden">
						{preview.map((sub) =>
							sub.icon ? (
								<sub.icon
									className="size-3"
									key={sub.title}
									style={{ color: sub.iconColor }}
								/>
							) : null,
						)}
					</span>
				) : null}
			</SidebarMenuButton>
			{item.badge ? (
				<SidebarMenuBadge>
					<Badge className="h-4 px-1.5 py-0 font-medium text-[10px]" variant="secondary">
						{item.badge}
					</Badge>
				</SidebarMenuBadge>
			) : null}
			{subItems && isActive ? (
				// The guide line *is* the rail: each child owns a 2px segment of it,
				// so the selected one lights the track itself instead of parking a
				// second amber bar a few pixels beside it.
				<SidebarMenuSub className="mx-0 ms-4 translate-x-0 gap-0 border-l-0 px-0 py-0">
					{subItems.map((sub) => (
						<SidebarMenuSubItem
							className={
								sub.href === activeSubHref
									? "border-sidebar-primary border-l-2 ps-2.5"
									: "border-sidebar-border border-l-2 ps-2.5"
							}
							key={sub.title}
						>
							<SidebarMenuSubButton
								className="translate-x-0 data-[active=true]:text-sidebar-primary [&>svg]:text-current"
								isActive={sub.href === activeSubHref}
								render={<Link to={sub.href} />}
							>
								{sub.icon ? (
									<sub.icon className="size-3.5" style={{ color: sub.iconColor }} />
								) : null}
								<span>{sub.title}</span>
							</SidebarMenuSubButton>
						</SidebarMenuSubItem>
					))}
					{discoverTo && hidden.length > 0 ? (
						<SidebarMenuSubItem
							className={
								discoverActive
									? "border-sidebar-primary border-l-2 ps-2.5"
									: "border-sidebar-border border-l-2 ps-2.5"
							}
						>
							<SidebarMenuSubButton
								className="translate-x-0 text-muted-foreground data-[active=true]:text-sidebar-primary hover:text-foreground"
								isActive={discoverActive}
								render={<Link to={discoverTo} />}
							>
								{/* One neutral mark in the same slot the sibling rows use,
								    so the row sits on their rhythm instead of breaking it.
								    A stack of the missing sources' own logos was the first
								    idea and the wrong one: three brand marks at 14px collide
								    into a smudge, and the column already carries one mark per
								    child. A compass says "go look" where a plus says "add
								    one" — the page behind this row is both. */}
								<CompassIcon className="size-3.5" />
								<span className="text-xs">Discover more</span>
							</SidebarMenuSubButton>
						</SidebarMenuSubItem>
					) : null}
				</SidebarMenuSub>
			) : null}
		</SidebarMenuItem>
	)
}

function NavGroupSection({
	group,
	currentPath,
	surfaces,
}: {
	group: NavGroup
	currentPath: string
	surfaces: ReadonlySet<NavSurface> | null
}) {
	return (
		<SidebarGroup>
			{group.label ? (
				<SidebarGroupLabel className={GROUP_LABEL}>{group.label}</SidebarGroupLabel>
			) : null}
			<SidebarGroupContent>
				<SidebarMenu>
					{group.items.map((item) => (
						<NavRow
							currentPath={currentPath}
							item={item}
							key={item.title}
							surfaces={surfaces}
						/>
					))}
				</SidebarMenu>
			</SidebarGroupContent>
		</SidebarGroup>
	)
}

/**
 * Replaces the old inline dashboards list, which had no ceiling — every
 * dashboard in the org landed in the sidebar behind a 160px scroll region with
 * a mask fade, nested inside the sidebar's own scroll region. This is curated,
 * capped, and reports the true total in its header.
 *
 * Labelled "Pinned dashboards" rather than "Pinned" because dashboards are all
 * it holds today — broaden the label at the same time the group starts taking
 * services and saved views, not before.
 *
 * Hidden on the collapsed rail for the same reason: with dashboards-only pins
 * every glyph is the same grid mark, so a column of them conveys nothing.
 * Services would bring a coloured ServiceDot and make the rail worth having.
 */
function PinnedGroup({ currentPath }: { currentPath: string }) {
	const { dashboards, isLoading } = useDashboardsRead()
	const { favorites } = useDashboardPreferences()

	const pinned = useMemo(() => dashboards.filter((d) => favorites.has(d.id)), [dashboards, favorites])
	const visible = pinned.slice(0, MAX_PINNED)
	const overflow = pinned.length - visible.length
	const activeDashboardId = currentPath.match(/^\/dashboards\/([^/]+)/)?.[1]

	if (isLoading) return null

	return (
		<SidebarGroup className="group-data-[collapsible=icon]:hidden">
			<SidebarGroupLabel className={GROUP_LABEL}>
				<span className="flex-1">Pinned dashboards</span>
				{pinned.length > 0 ? <span className="font-normal tabular-nums">{pinned.length}</span> : null}
			</SidebarGroupLabel>
			<SidebarGroupContent>
				{visible.length === 0 ? (
					<p className="rounded-md border border-sidebar-border border-dashed px-2.5 py-2 text-[11px] text-muted-foreground leading-relaxed">
						Pin a dashboard to keep it here.
					</p>
				) : (
					<SidebarMenu>
						{visible.map((dashboard) => (
							<SidebarMenuItem key={dashboard.id}>
								<SidebarMenuButton
									className={ACTIVE_RAIL}
									isActive={activeDashboardId === dashboard.id}
									render={
										<Link
											params={{ dashboardId: dashboard.id }}
											to="/dashboards/$dashboardId"
										/>
									}
									size="sm"
								>
									<GridSquareCirclePlusIcon className="size-3.5 text-muted-foreground" />
									<span>{dashboard.name}</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
						))}
						{overflow > 0 ? (
							<SidebarMenuItem>
								<SidebarMenuButton
									className={`${ACTIVE_RAIL} text-muted-foreground`}
									render={<Link to="/dashboards" />}
									size="sm"
								>
									<span className="size-3.5 shrink-0" />
									<span>{overflow} more…</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
						) : null}
					</SidebarMenu>
				)}
			</SidebarGroupContent>
		</SidebarGroup>
	)
}

/**
 * A full nav row rather than a 32px glyph beside the avatar: Settings is a
 * destination like any other section, and pairing it with the user menu read as
 * "account settings" when it is org- and project-wide. It stays in the footer so
 * it never scrolls away behind a long Pinned list.
 */
function SettingsRow({ currentPath }: { currentPath: string }) {
	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<SidebarMenuButton
					className={ACTIVE_RAIL}
					isActive={isPathActive(currentPath, "/settings")}
					render={<Link to="/settings" />}
					tooltip="Settings"
				>
					<GearIcon size={18} />
					<span>Settings</span>
				</SidebarMenuButton>
			</SidebarMenuItem>
		</SidebarMenu>
	)
}

/** Support stops scrolling away by leaving SidebarContent entirely. */
function SupportMenu() {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<SidebarMenuButton
						className="size-8 w-8 shrink-0 justify-center p-0 group-data-[collapsible=icon]:w-full"
						tooltip="Support"
					/>
				}
			>
				<CircleQuestionIcon size={16} />
				<span className="sr-only">Support</span>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" side="top" sideOffset={4}>
				<DropdownMenuGroup>
					<DropdownMenuItem
						render={
							<a
								aria-label="Community Discord"
								href="https://discord.gg/BnXjKuwJqP"
								rel="noopener noreferrer"
								target="_blank"
							/>
						}
					>
						<DiscordIcon size={16} />
						Community Discord
					</DropdownMenuItem>
					<DropdownMenuItem
						render={<a aria-label="Email Support" href="mailto:support@maple.dev" />}
					>
						<EnvelopeIcon size={16} />
						Email Support
					</DropdownMenuItem>
					<DropdownMenuItem onClick={showKeyboardShortcuts}>
						<KeyboardIcon size={16} />
						Keyboard shortcuts
						<DropdownMenuShortcut>?</DropdownMenuShortcut>
					</DropdownMenuItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function FooterCluster() {
	return (
		<SidebarMenu>
			<SidebarMenuItem className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col">
				<div className="min-w-0 flex-1 group-data-[collapsible=icon]:w-full group-data-[collapsible=icon]:flex-none">
					{isClerkAuthEnabled ? <UserMenu /> : <GuestMenu />}
				</div>
				<SupportMenu />
			</SidebarMenuItem>
		</SidebarMenu>
	)
}

// The flag read lives in this small child rather than in `AppSidebar`: memo
// gates props, not context, so a Clerk hook in the shell would subscribe the
// whole sidebar to Clerk's provider and rerender it on every resource tick.
// Confined here, a tick redraws only the nav groups — the subtree that already
// redraws on every navigation.
const SidebarNavGroups = memo(function SidebarNavGroups({ currentPath }: { currentPath: string }) {
	// Fails closed while Clerk loads, so a flagged row arrives a beat late rather
	// than flashing and vanishing — the trade `navGroups` documents.
	const { flags } = useOrganizationFeatureFlags()
	// Lives here for the same reason the flag read does — one subscription for
	// the whole nav rather than one per row, in the subtree that already redraws
	// on navigation.
	const surfaces = useInfraSurfaces()
	const groups = navGroups(flags)
	return groups.map((group) => (
		<NavGroupSection currentPath={currentPath} group={group} key={group.id} surfaces={surfaces} />
	))
})

// Memoized: DashboardLayout renders this inside every page, so without memo the
// sidebar's ~500-fiber subtree rerenders on every page-level state change
// (refresh version bumps, search-param updates, query settles). The selector
// (instead of bare useRouterState) keeps it quiet during loader/pending ticks.
export const AppSidebar = memo(function AppSidebar() {
	const currentPath = useRouterState({ select: (s) => s.location.pathname })

	return (
		<Sidebar collapsible="icon">
			<SidebarHeader>
				<OrgSwitcher />
				<SearchRow />
			</SidebarHeader>
			<SidebarContent>
				<SidebarNavGroups currentPath={currentPath} />
				<PinnedGroup currentPath={currentPath} />
			</SidebarContent>
			{/* The rule belongs between Settings and the account cluster, not above
			    both: Settings is the last nav row, so a line above it would cut it
			    off from the nav it belongs to. */}
			<SidebarFooter>
				<SettingsRow currentPath={currentPath} />
				<div className="-mx-2 border-sidebar-border border-t px-2 pt-2">
					<FooterCluster />
				</div>
			</SidebarFooter>
		</Sidebar>
	)
})
