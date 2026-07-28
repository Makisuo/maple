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
	MagnifierIcon,
} from "@/components/icons"
import {
	isNavItemActive,
	isPathActive,
	navGroups,
	type NavGroup,
	type NavItem,
} from "@/components/dashboard/nav-items"
import { openCommandPalette, showKeyboardShortcuts } from "@/components/command-palette/global-shortcuts"
import { OrgSwitcher } from "@/components/dashboard/org-switcher"
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
import { useInfraEnabled } from "@/hooks/use-infra-enabled"

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

function UserAvatar({
	imageUrl,
	initials,
	name,
	className,
}: {
	imageUrl?: string
	initials: string
	name: string
	className?: string
}) {
	const base = className ?? "size-6 rounded-md text-[10px]"
	return imageUrl ? (
		<img alt={name} className={`${base} shrink-0 object-cover`} src={imageUrl} />
	) : (
		<div
			className={`${base} flex shrink-0 items-center justify-center bg-muted font-medium text-muted-foreground`}
		>
			{initials}
		</div>
	)
}

function UserMenu() {
	const { user } = useUser()
	const { signOut } = useClerk()

	const name = user?.fullName ?? "User"
	const email = user?.primaryEmailAddress?.emailAddress ?? ""
	const imageUrl = user?.imageUrl
	const initials = name
		.split(" ")
		.map((n) => n[0])
		.join("")
		.slice(0, 2)
		.toUpperCase()

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

function GuestMenu() {
	const handleLogout = () => {
		clearSelfHostedSessionToken()
		window.location.assign("/sign-in")
	}

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
					<DropdownMenuItem onClick={handleLogout}>
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

function NavRow({ item, currentPath }: { item: NavItem; currentPath: string }) {
	const { state, isMobile } = useSidebar()
	const isActive = isNavItemActive(currentPath, item)
	const subItems = item.subItems
	const collapsed = state === "collapsed" && !isMobile

	// Longest match wins: Infrastructure's Hosts child is `/infra`, which
	// prefixes every one of its siblings, so a plain match would light up two
	// rows on /infra/kubernetes/pods.
	const activeSubHref = useMemo(() => {
		let best: string | undefined
		for (const sub of subItems ?? []) {
			if (!isPathActive(currentPath, sub.href)) continue
			if (best === undefined || sub.href.length > best.length) best = sub.href
		}
		return best
	}, [subItems, currentPath])

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
						{/* Base UI scopes labels to a group — a bare DropdownMenuLabel
						    throws MenuGroupContext is missing. */}
						<DropdownMenuGroup>
							<DropdownMenuLabel>{item.title}</DropdownMenuLabel>
							{subItems.map((sub) => (
								<DropdownMenuItem key={sub.title} render={<Link to={sub.href} />}>
									{sub.icon ? <sub.icon size={16} /> : null}
									{sub.title}
								</DropdownMenuItem>
							))}
						</DropdownMenuGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarMenuItem>
		)
	}

	// While a section is open the rail belongs to the child you're actually on,
	// not the parent — otherwise two amber bars compete and neither points at
	// the current page. The open parent keeps the fill.
	const isOpen = Boolean(subItems && subItems.length > 0 && isActive)

	return (
		<SidebarMenuItem>
			<SidebarMenuButton
				className={isOpen ? RAIL_LANE : ACTIVE_RAIL}
				isActive={isActive}
				render={<Link to={item.href} />}
				tooltip={item.title}
			>
				<item.icon size={18} />
				<span>{item.title}</span>
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
								{sub.icon ? <sub.icon className="size-3.5" /> : null}
								<span>{sub.title}</span>
							</SidebarMenuSubButton>
						</SidebarMenuSubItem>
					))}
				</SidebarMenuSub>
			) : null}
		</SidebarMenuItem>
	)
}

function NavGroupSection({ group, currentPath }: { group: NavGroup; currentPath: string }) {
	return (
		<SidebarGroup>
			{group.label ? (
				<SidebarGroupLabel className={GROUP_LABEL}>{group.label}</SidebarGroupLabel>
			) : null}
			<SidebarGroupContent>
				<SidebarMenu>
					{group.items.map((item) => (
						<NavRow currentPath={currentPath} item={item} key={item.title} />
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

/** Settings and help stop scrolling away by leaving SidebarContent entirely. */
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

function FooterCluster({ currentPath }: { currentPath: string }) {
	return (
		<SidebarMenu>
			<SidebarMenuItem className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col">
				<div className="min-w-0 flex-1 group-data-[collapsible=icon]:w-full group-data-[collapsible=icon]:flex-none">
					{isClerkAuthEnabled ? <UserMenu /> : <GuestMenu />}
				</div>
				<SidebarMenuButton
					className={`${ACTIVE_RAIL} size-8 w-8 shrink-0 justify-center p-0 group-data-[collapsible=icon]:w-full`}
					isActive={isPathActive(currentPath, "/settings")}
					render={<Link to="/settings" />}
					tooltip="Settings"
				>
					<GearIcon size={16} />
					<span className="sr-only">Settings</span>
				</SidebarMenuButton>
				<SupportMenu />
			</SidebarMenuItem>
		</SidebarMenu>
	)
}

// Memoized: DashboardLayout renders this inside every page, so without memo the
// sidebar's ~500-fiber subtree rerenders on every page-level state change
// (refresh version bumps, search-param updates, query settles). The selector
// (instead of bare useRouterState) keeps it quiet during loader/pending ticks.
export const AppSidebar = memo(function AppSidebar() {
	const currentPath = useRouterState({ select: (s) => s.location.pathname })
	const infraEnabled = useInfraEnabled()
	const groups = useMemo(() => navGroups({ infraEnabled }), [infraEnabled])

	return (
		<Sidebar collapsible="icon">
			<SidebarHeader>
				<OrgSwitcher />
				<SearchRow />
			</SidebarHeader>
			<SidebarContent>
				{groups.map((group) => (
					<NavGroupSection currentPath={currentPath} group={group} key={group.id} />
				))}
				<PinnedGroup currentPath={currentPath} />
			</SidebarContent>
			<SidebarFooter className="border-sidebar-border border-t">
				<FooterCluster currentPath={currentPath} />
			</SidebarFooter>
		</Sidebar>
	)
})
