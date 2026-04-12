import { Link, useRouterState } from "@tanstack/react-router";
import { useUser, useClerk } from "@clerk/clerk-react";
import {
  HouseIcon,
  FileIcon,
  PulseIcon,
  ChartLineIcon,
  ServerIcon,
  BellIcon,
  CircleWarningIcon,
  CircleQuestionIcon,
  DiscordIcon,
  EnvelopeIcon,
  GearIcon,
  LogoutIcon,
  ChevronUpIcon,
  ChevronRightIcon,
  NetworkNodesIcon,
  ChatBubbleSparkleIcon,
  GridIcon,
} from "@/components/icons";
import { OrgSwitcher } from "@/components/dashboard/org-switcher";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu";
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
} from "@maple/ui/components/ui/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@maple/ui/components/ui/collapsible";
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode";
import { clearSelfHostedSessionToken } from "@/lib/services/common/self-hosted-auth";
import { useDashboardStore } from "@/hooks/use-dashboard-store";
import { useDashboardPreferences } from "@/hooks/use-dashboard-preferences";
import { Badge } from "@maple/ui/components/ui/badge";

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
];

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
];

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
];

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
];

function UserAvatar({
  imageUrl,
  initials,
  name,
}: {
  imageUrl?: string;
  initials: string;
  name: string;
}) {
  return imageUrl ? (
    <img src={imageUrl} alt={name} className="size-8 shrink-0 rounded-md object-cover" />
  ) : (
    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground text-xs font-medium">
      {initials}
    </div>
  );
}

function UserMenu() {
  const { user } = useUser();
  const { signOut } = useClerk();

  const name = user?.fullName ?? "User";
  const email = user?.primaryEmailAddress?.emailAddress ?? "";
  const imageUrl = user?.imageUrl;
  const initials = name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

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
                {email && <span className="truncate text-xs text-muted-foreground">{email}</span>}
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
  );
}

function GuestMenu() {
  const handleLogout = () => {
    clearSelfHostedSessionToken();
    window.location.assign("/sign-in");
  };

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
  );
}

export function AppSidebar() {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;
  const { dashboards, isLoading } = useDashboardStore();
  const { favorites } = useDashboardPreferences();

  const dashboardMatch = currentPath.match(/^\/dashboards\/([^/]+)/);
  const activeDashboardId = dashboardMatch?.[1];

  const favoriteDashboards = dashboards.filter((d) => favorites.has(d.id));
  const otherDashboards = dashboards.filter((d) => !favorites.has(d.id));

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
                const isActive = currentPath === item.href;
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
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {[topologyNavItems, signalsNavItems, investigateNavItems].map((group) => (
          <SidebarGroup key={group[0].title}>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.map((item) => {
                  const isActive = currentPath.startsWith(item.href);
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
                          <Badge
                            variant="secondary"
                            className="text-[10px] px-1.5 py-0 h-4 font-medium"
                          >
                            {item.badge as string}
                          </Badge>
                        </SidebarMenuBadge>
                      ) : null}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}

        <Collapsible defaultOpen className="group/dashboards flex flex-1 min-h-0 flex-col">
          <SidebarGroup className="flex flex-1 min-h-0 flex-col">
            <SidebarGroupLabel render={<CollapsibleTrigger />}>
              <GridIcon size={14} className="mr-1 !size-3.5" />
              Dashboards
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-medium">
                Beta
              </Badge>
              <ChevronRightIcon
                size={14}
                className="ml-auto !size-3.5 transition-transform group-data-[open]/dashboards:rotate-90"
              />
            </SidebarGroupLabel>
            <CollapsibleContent className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <SidebarGroupContent className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <SidebarMenu className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      render={<Link to="/dashboards" />}
                      tooltip="All Dashboards"
                      isActive={currentPath === "/dashboards" || currentPath === "/dashboards/"}
                    >
                      <GridIcon size={18} />
                      <span>All Dashboards</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  {!isLoading && dashboards.length > 0 && (
                    <SidebarMenuSub className="min-h-0 flex-1 overflow-y-auto">
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

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<SidebarMenuButton tooltip="Support" />}
                  >
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
                          />
                        }
                      >
                        <DiscordIcon size={16} />
                        Community Discord
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        render={<a href="mailto:support@maple.dev" />}
                      >
                        <EnvelopeIcon size={16} />
                        Email Support
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
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>{isClerkAuthEnabled ? <UserMenu /> : <GuestMenu />}</SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
