import { Link, useRouterState } from "@tanstack/react-router"
import { useUser, useClerk } from "@clerk/clerk-react"
import {
  HouseIcon,
  FileIcon,
  PulseIcon,
  ChartLineIcon,
  ServerIcon,
  BellIcon,
  CircleWarningIcon,
  GearIcon,
  LogoutIcon,
  ChevronUpIcon,
  ChevronRightIcon,
  NetworkNodesIcon,
  ChatBubbleSparkleIcon,
  GridIcon,
} from "@/components/icons"
import { OrgSwitcher } from "@/components/dashboard/org-switcher"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
} from "@maple/ui/components/ui/sidebar"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@maple/ui/components/ui/collapsible"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { clearSelfHostedSessionToken } from "@/lib/services/common/self-hosted-auth"
import { useTrialStatus } from "@/hooks/use-trial-status"
import { useDashboardStore } from "@/hooks/use-dashboard-store"
import { Badge } from "@maple/ui/components/ui/badge"
import { ClockIcon } from "@/components/icons"

const mainNavItems = [
  {
    title: "Overview",
    href: "/",
    icon: HouseIcon,
  },
  {
    title: "Chat",
    href: "/chat",
    icon: ChatBubbleSparkleIcon,
  },
]

const topologyNavItems = [
  {
    title: "Services",
    href: "/services",
    icon: ServerIcon,
  },
  {
    title: "Service Map",
    href: "/service-map",
    icon: NetworkNodesIcon,
  },
]

const signalsNavItems = [
  {
    title: "Traces",
    href: "/traces",
    icon: PulseIcon,
  },
  {
    title: "Logs",
    href: "/logs",
    icon: FileIcon,
  },
  {
    title: "Metrics",
    href: "/metrics",
    icon: ChartLineIcon,
  },
]

const investigateNavItems = [
  {
    title: "Errors",
    href: "/errors",
    icon: CircleWarningIcon,
  },
  {
    title: "Alerts",
    href: "/alerts",
    icon: BellIcon,
    badge: "Beta",
  },
]

function UserAvatar({
  imageUrl,
  initials,
  name,
}: {
  imageUrl?: string
  initials: string
  name: string
}) {
  return imageUrl ? (
    <img
      src={imageUrl}
      alt={name}
      className="size-8 shrink-0 rounded-md object-cover"
    />
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
          {email && (
            <span className="truncate text-xs text-muted-foreground">
              {email}
            </span>
          )}
        </div>
        <ChevronUpIcon size={16} className="ml-auto" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={4}
        className="min-w-56"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <div className="flex items-center gap-2 py-1 text-left text-sm">
              <UserAvatar imageUrl={imageUrl} initials={initials} name={name} />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{name}</span>
                {email && (
                  <span className="truncate text-xs text-muted-foreground">
                    {email}
                  </span>
                )}
              </div>
            </div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem render={<Link to="/settings" />}>
            <GearIcon size={16} />
            Settings
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
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={4}
        className="min-w-56"
      >
        <DropdownMenuGroup>
          <DropdownMenuItem render={<Link to="/settings" />}>
            <GearIcon size={16} />
            Settings
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

function PlanBadge() {
  const { isTrialing, daysRemaining, planName, planStatus, isLoading } = useTrialStatus()

  if (isLoading || !planStatus) return null

  const label = isTrialing ? `${planName} Trial` : planName

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        render={<Link to="/settings" search={{ tab: "billing" }} />}
        tooltip={isTrialing ? `${label} · ${daysRemaining}d left` : label ?? "Plan"}
        size="sm"
        className="text-muted-foreground"
      >
        <ClockIcon size={16} />
        <span className="truncate text-xs">{label}</span>
      </SidebarMenuButton>
      {isTrialing && daysRemaining != null && (
        <SidebarMenuBadge>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-medium">
            {daysRemaining}d left
          </Badge>
        </SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  )
}

export function AppSidebar() {
  const routerState = useRouterState()
  const currentPath = routerState.location.pathname
  const { dashboards, isLoading } = useDashboardStore()

  const activeDashboardId = (routerState.location.search as Record<string, unknown>)?.dashboardId as string | undefined

  const isDashboardsRoute = currentPath === "/dashboards"

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <OrgSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {mainNavItems.map((item) => {
                const isActive = currentPath === item.href
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      render={<Link to={item.href} />}
                      tooltip={item.title}
                      isActive={isActive}
                    >
                      <item.icon size={18} />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <Collapsible defaultOpen className="group/dashboards">
          <SidebarGroup>
            <SidebarGroupLabel render={<CollapsibleTrigger />}>
              <GridIcon size={14} className="mr-1 !size-3.5" />
              Dashboards
              <ChevronRightIcon size={14} className="ml-auto !size-3.5 transition-transform group-data-[open]/dashboards:rotate-90" />
            </SidebarGroupLabel>
            <CollapsibleContent>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      render={<Link to="/dashboards" />}
                      tooltip="All Dashboards"
                      isActive={isDashboardsRoute && !activeDashboardId}
                    >
                      <span>All Dashboards</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  {!isLoading && dashboards.length > 0 && (
                    <SidebarMenuSub>
                      {dashboards.map((dashboard) => (
                        <SidebarMenuSubItem key={dashboard.id}>
                          <SidebarMenuSubButton
                            render={
                              <Link
                                to="/dashboards"
                                search={{ dashboardId: dashboard.id }}
                              />
                            }
                            isActive={
                              isDashboardsRoute &&
                              activeDashboardId === dashboard.id
                            }
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

        {[topologyNavItems, signalsNavItems, investigateNavItems].map(
          (group) => (
            <SidebarGroup key={group[0].title}>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.map((item) => {
                    const isActive = currentPath.startsWith(item.href)
                    return (
                      <SidebarMenuItem key={item.title}>
                        <SidebarMenuButton
                          render={<Link to={item.href} />}
                          tooltip={item.title}
                          isActive={isActive}
                        >
                          <item.icon size={18} />
                          <span>{item.title}</span>
                        </SidebarMenuButton>
                        {"badge" in item && (item.badge as string) ? (
                          <SidebarMenuBadge>
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-medium">
                              {item.badge as string}
                            </Badge>
                          </SidebarMenuBadge>
                        ) : null}
                      </SidebarMenuItem>
                    )
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ),
        )}

        <div className="flex-1" />

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
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
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          {isClerkAuthEnabled && <PlanBadge />}
          <SidebarMenuItem>
            {isClerkAuthEnabled ? <UserMenu /> : <GuestMenu />}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
