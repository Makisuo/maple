import { useOrganization } from "@clerk/clerk-react"
import { ChevronExpandYIcon, ServerIcon } from "@/components/icons"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@maple/ui/components/ui/dropdown-menu"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@maple/ui/components/ui/sidebar"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { useGlobalNamespace } from "@/hooks/use-global-namespace"
import { ClerkOrgSwitcherMenu, OrgAvatar } from "./org-switcher-menu"
import { NamespaceScopeMenuGroup } from "./namespace-scope-menu"

function ClerkOrgSwitcher() {
	const { organization } = useOrganization()
	const pinnedNamespace = useGlobalNamespace()
	const orgName = organization?.name ?? "Select Organization"
	const orgImageUrl = organization?.imageUrl

	return (
		<ClerkOrgSwitcherMenu
			contentSide="right"
			contentAlign="start"
			namespaceScope
			trigger={
				<SidebarMenuButton
					size="lg"
					className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
				>
					<OrgAvatar name={orgName} imageUrl={orgImageUrl} />
					<div className="grid flex-1 text-left text-sm leading-tight">
						<span className="truncate font-medium">{orgName}</span>
						{pinnedNamespace !== null ? (
							<span className="truncate text-xs font-medium text-primary">
								{pinnedNamespace}
							</span>
						) : (
							<span className="truncate text-xs text-muted-foreground">Organization</span>
						)}
					</div>
					<ChevronExpandYIcon size={16} className="ml-auto" />
				</SidebarMenuButton>
			}
		/>
	)
}

function SelfHostedOrgSwitcher() {
	const pinnedNamespace = useGlobalNamespace()

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<SidebarMenuButton
						size="lg"
						className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
					>
						<div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
							<ServerIcon size={16} />
						</div>
						<div className="grid flex-1 text-left text-sm leading-tight">
							<span className="truncate font-medium">Self Hosted</span>
							{pinnedNamespace !== null && (
								<span className="truncate text-xs font-medium text-primary">
									{pinnedNamespace}
								</span>
							)}
						</div>
						<ChevronExpandYIcon size={16} className="ml-auto" />
					</SidebarMenuButton>
				}
			/>
			<DropdownMenuContent side="right" align="start" sideOffset={4} className="min-w-56">
				<NamespaceScopeMenuGroup emptyNotice />
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

export function OrgSwitcher() {
	return (
		<SidebarMenu>
			<SidebarMenuItem>
				{isClerkAuthEnabled ? <ClerkOrgSwitcher /> : <SelfHostedOrgSwitcher />}
			</SidebarMenuItem>
		</SidebarMenu>
	)
}
