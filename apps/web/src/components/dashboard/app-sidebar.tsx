import { memo, useState } from "react"
import { Link, useRouterState } from "@tanstack/react-router"
import { useUser, useClerk } from "@clerk/clerk-react"
import {
	CircleQuestionIcon,
	DiscordIcon,
	EnvelopeIcon,
	GearIcon,
	LogoutIcon,
	ChevronUpIcon,
	ChevronRightIcon,
	GridSquareCirclePlusIcon,
	PencilIcon,
} from "@/components/icons"
import {
	investigateNavItems,
	mainNavItems,
	topologyNavItems,
	visibleSignalsNavItems,
} from "@/components/dashboard/nav-items"
import { SidebarEditBar, SidebarNavGroup } from "@/components/dashboard/sidebar-nav-group"
import { useSidebarPreferences } from "@/hooks/use-sidebar-preferences"
import { showKeyboardShortcuts } from "@/components/command-palette/global-shortcuts"
import { KeyboardIcon } from "@/components/icons"
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
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
	useSidebar,
} from "@maple/ui/components/ui/sidebar"
import { cn } from "@maple/ui/utils"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@maple/ui/components/ui/collapsible"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { clearSelfHostedSessionToken } from "@/lib/services/common/self-hosted-auth"
import { useDashboardsRead } from "@/hooks/use-dashboard-store"
import { useDashboardPreferences } from "@/hooks/use-dashboard-preferences"
import { useInfraEnabled } from "@/hooks/use-infra-enabled"

function UserAvatar({ imageUrl, initials, name }: { imageUrl?: string; initials: string; name: string }) {
	return imageUrl ? (
		<img src={imageUrl} alt={name} className="size-8 shrink-0 rounded-md object-cover" />
	) : (
		<div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground text-xs font-medium">
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
						size="lg"
						className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
					/>
				}
			>
				<UserAvatar imageUrl={imageUrl} initials={initials} name={name} />
				<div className="grid flex-1 text-left text-sm leading-tight">
					<span className="truncate font-medium">{name}</span>
					{email && <span className="truncate text-xs text-muted-foreground">{email}</span>}
				</div>
				<ChevronUpIcon size={16} className="ml-auto" />
			</DropdownMenuTrigger>
			<DropdownMenuContent side="top" align="start" sideOffset={4} className="min-w-56">
				<DropdownMenuGroup>
					<DropdownMenuLabel>
						<div className="flex items-center gap-2 py-1 text-left text-sm">
							<UserAvatar imageUrl={imageUrl} initials={initials} name={name} />
							<div className="grid flex-1 text-left text-sm leading-tight">
								<span className="truncate font-medium">{name}</span>
								{email && (
									<span className="truncate text-xs text-muted-foreground">{email}</span>
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
						size="lg"
						className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
					/>
				}
			>
				<UserAvatar initials="RT" name="Root" />
				<div className="grid flex-1 text-left text-sm leading-tight">
					<span className="truncate font-medium">Root</span>
				</div>
				<ChevronUpIcon size={16} className="ml-auto" />
			</DropdownMenuTrigger>
			<DropdownMenuContent side="top" align="start" sideOffset={4} className="min-w-56">
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

// Memoized: DashboardLayout renders this inside every page, so without memo the
// sidebar's ~500-fiber subtree rerenders on every page-level state change
// (refresh version bumps, search-param updates, query settles). The selector
// (instead of bare useRouterState) keeps it quiet during loader/pending ticks.
export const AppSidebar = memo(function AppSidebar() {
	const currentPath = useRouterState({ select: (s) => s.location.pathname })
	const { dashboards, isLoading } = useDashboardsRead()
	const { favorites } = useDashboardPreferences()

	const dashboardMatch = currentPath.match(/^\/dashboards\/([^/]+)/)
	const activeDashboardId = dashboardMatch?.[1]

	const favoriteDashboards = dashboards.filter((d) => favorites.has(d.id))
	const otherDashboards = dashboards.filter((d) => !favorites.has(d.id))

	const infraEnabled = useInfraEnabled()
	const signalsItems = visibleSignalsNavItems({ infraEnabled })

	const [editing, setEditing] = useState(false)
	const { state, setOpen } = useSidebar()
	const { resetToDefaults, isCustomized } = useSidebarPreferences()
	// Collapsing the rail mid-edit acts as an implicit Done (prefs save live);
	// adjust during render instead of an effect.
	if (editing && state === "collapsed") {
		setEditing(false)
	}
	const inEdit = editing && state === "expanded"

	return (
		<Sidebar collapsible="icon">
			<SidebarHeader className={cn(inEdit && "pointer-events-none opacity-60")}>
				<OrgSwitcher />
			</SidebarHeader>
			{inEdit ? (
				<SidebarEditBar
					isCustomized={isCustomized}
					onReset={resetToDefaults}
					onDone={() => setEditing(false)}
				/>
			) : null}
			<SidebarContent
				onKeyDown={(e) => {
					if (e.key === "Escape") setEditing(false)
				}}
			>
				<SidebarNavGroup
					groupId="main"
					items={mainNavItems}
					currentPath={currentPath}
					editing={inEdit}
				/>
				<SidebarNavGroup
					groupId="topology"
					items={topologyNavItems}
					currentPath={currentPath}
					editing={inEdit}
				/>
				<SidebarNavGroup
					groupId="signals"
					items={signalsItems}
					currentPath={currentPath}
					editing={inEdit}
				/>
				<SidebarNavGroup
					groupId="investigate"
					items={investigateNavItems}
					currentPath={currentPath}
					editing={inEdit}
				/>

				<Collapsible
					defaultOpen
					className={cn("group/dashboards flex flex-col", inEdit && "pointer-events-none opacity-60")}
				>
					<SidebarGroup className="flex flex-col">
						<SidebarGroupLabel render={<CollapsibleTrigger />}>
							<GridSquareCirclePlusIcon size={14} className="mr-1 !size-3.5" />
							Dashboards
							<ChevronRightIcon
								size={14}
								className="ml-auto !size-3.5 transition-transform group-data-[open]/dashboards:rotate-90"
							/>
						</SidebarGroupLabel>
						<CollapsibleContent className="flex flex-col">
							<SidebarGroupContent className="flex flex-col">
								<SidebarMenu className="flex flex-col">
									<SidebarMenuItem>
										<SidebarMenuButton
											render={<Link to="/dashboards" />}
											tooltip="All Dashboards"
											isActive={
												currentPath === "/dashboards" ||
												currentPath === "/dashboards/"
											}
										>
											<GridSquareCirclePlusIcon size={18} />
											<span>All Dashboards</span>
										</SidebarMenuButton>
									</SidebarMenuItem>
									{!isLoading && dashboards.length > 0 && (
										<SidebarMenuSub className="max-h-40 overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent_0,black_8px,black_calc(100%-8px),transparent_100%)]">
											{favoriteDashboards.map((dashboard) => (
												<SidebarMenuSubItem key={dashboard.id}>
													<SidebarMenuSubButton
														render={
															<Link
																to="/dashboards/$dashboardId"
																params={{ dashboardId: dashboard.id }}
															/>
														}
														isActive={activeDashboardId === dashboard.id}
													>
														<span className="text-amber-500 mr-1">&#9733;</span>
														<span>{dashboard.name}</span>
													</SidebarMenuSubButton>
												</SidebarMenuSubItem>
											))}
											{otherDashboards.map((dashboard) => (
												<SidebarMenuSubItem key={dashboard.id}>
													<SidebarMenuSubButton
														render={
															<Link
																to="/dashboards/$dashboardId"
																params={{ dashboardId: dashboard.id }}
															/>
														}
														isActive={activeDashboardId === dashboard.id}
													>
														<span>{dashboard.name}</span>
													</SidebarMenuSubButton>
												</SidebarMenuSubItem>
											))}
										</SidebarMenuSub>
									)}
								</SidebarMenu>
							</SidebarGroupContent>
						</CollapsibleContent>
					</SidebarGroup>
				</Collapsible>

				<SidebarGroup className={cn(inEdit && "pointer-events-none opacity-60")}>
					<SidebarGroupContent>
						<SidebarMenu>
							<SidebarMenuItem>
								<DropdownMenu>
									<DropdownMenuTrigger render={<SidebarMenuButton tooltip="Support" />}>
										<CircleQuestionIcon size={18} />
										<span>Support</span>
									</DropdownMenuTrigger>
									<DropdownMenuContent side="right" align="start" sideOffset={4}>
										<DropdownMenuGroup>
											<DropdownMenuItem
												render={
													<a
														href="https://discord.gg/BnXjKuwJqP"
														target="_blank"
														rel="noopener noreferrer"
														aria-label="Community Discord"
													/>
												}
											>
												<DiscordIcon size={16} />
												Community Discord
											</DropdownMenuItem>
											<DropdownMenuItem
												render={
													<a
														href="mailto:support@maple.dev"
														aria-label="Email Support"
													/>
												}
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
							</SidebarMenuItem>
							<SidebarMenuItem>
								<SidebarMenuButton
									render={<Link to="/settings" />}
									tooltip="Settings"
									isActive={currentPath.startsWith("/settings")}
								>
									<GearIcon size={18} />
									<span>Settings</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
							<SidebarMenuItem>
								<SidebarMenuButton
									tooltip="Customize sidebar"
									onClick={() => {
										setOpen(true)
										setEditing(true)
									}}
								>
									<PencilIcon size={18} />
									<span>Customize sidebar</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>
			</SidebarContent>
			<SidebarFooter className={cn(inEdit && "pointer-events-none opacity-60")}>
				<SidebarMenu>
					<SidebarMenuItem>{isClerkAuthEnabled ? <UserMenu /> : <GuestMenu />}</SidebarMenuItem>
				</SidebarMenu>
			</SidebarFooter>
		</Sidebar>
	)
})
