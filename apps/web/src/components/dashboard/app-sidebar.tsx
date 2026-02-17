import { Link, useRouterState } from "@tanstack/react-router"
import { useUser, useClerk } from "@clerk/clerk-react"
import {
  HouseIcon,
  FileIcon,
  PulseIcon,
  ChartLineIcon,
  ServerIcon,
  CircleWarningIcon,
  MagnifierIcon,
  GearIcon,
  LogoutIcon,
  ChevronUpIcon,
  RocketIcon,
  CheckIcon,
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
} from "@/components/ui/dropdown-menu"
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
} from "@/components/ui/sidebar"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { clearSelfHostedSessionToken } from "@/lib/services/common/self-hosted-auth"
import { useQuickStart } from "@/hooks/use-quick-start"

const navItems = [
  {
    title: "Overview",
    href: "/",
    icon: HouseIcon,
  },
  {
    title: "Services",
    href: "/services",
    icon: ServerIcon,
  },
  {
    title: "Errors",
    href: "/errors",
    icon: CircleWarningIcon,
  },
  {
    title: "Logs",
    href: "/logs",
    icon: FileIcon,
  },
  {
    title: "Traces",
    href: "/traces",
    icon: PulseIcon,
  },
  {
    title: "Metrics",
    href: "/metrics",
    icon: ChartLineIcon,
  },
  {
    title: "Query Lab",
    href: "/query-builder-lab",
    icon: MagnifierIcon,
  },
  {
    title: "Settings",
    href: "/settings",
    icon: GearIcon,
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
          <DropdownMenuItem render={<Link to="/settings" search={{ tab: "ingestion" }} />}>
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
          <DropdownMenuItem render={<Link to="/settings" search={{ tab: "ingestion" }} />}>
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

export function AppSidebar() {
  const routerState = useRouterState()
  const currentPath = routerState.location.pathname
  const { isDismissed, isComplete, progressPercent } = useQuickStart()

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <OrgSwitcher />
      </SidebarHeader>
      <SidebarContent>
        {!isDismissed && (
          <SidebarGroup>
            <SidebarGroupLabel>Get Started</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    render={<Link to="/quick-start" />}
                    tooltip="Quick Start"
                    isActive={currentPath === "/quick-start"}
                  >
                    <RocketIcon size={16} />
                    <span>Quick Start</span>
                  </SidebarMenuButton>
                  <SidebarMenuBadge>
                    {isComplete ? (
                      <CheckIcon size={12} className="text-emerald-500" />
                    ) : (
                      <span className="text-[10px]">{progressPercent}%</span>
                    )}
                  </SidebarMenuBadge>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
                const isActive =
                  item.href === "/"
                    ? currentPath === "/"
                    : currentPath.startsWith(item.href)

                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      render={<Link to={item.href} />}
                      tooltip={item.title}
                      isActive={isActive}
                    >
                      <item.icon size={16} />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            {isClerkAuthEnabled ? <UserMenu /> : <GuestMenu />}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
