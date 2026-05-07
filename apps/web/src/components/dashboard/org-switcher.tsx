import { useOrganization } from "@clerk/clerk-react"
import { ChevronExpandYIcon, ServerIcon } from "@/components/icons"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@maple/ui/components/ui/sidebar"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { ClerkOrgSwitcherMenu, OrgAvatar } from "./org-switcher-menu"

function ClerkOrgSwitcher() {
	const { organization } = useOrganization()
	const orgName = organization?.name ?? "Select Organization"
	const orgImageUrl = organization?.imageUrl

	return (
		<ClerkOrgSwitcherMenu
			contentSide="right"
			contentAlign="start"
			trigger={
				<SidebarMenuButton
					size="lg"
					className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
				>
					<OrgAvatar name={orgName} imageUrl={orgImageUrl} />
					<div className="grid flex-1 text-left text-sm leading-tight">
						<span className="truncate font-medium">{orgName}</span>
						<span className="truncate text-xs text-muted-foreground">Organization</span>
					</div>
					<ChevronExpandYIcon size={16} className="ml-auto" />
				</SidebarMenuButton>
			}
		/>
	)
}

function SelfHostedOrgSwitcher() {
	return (
		<SidebarMenuButton size="lg" className="cursor-default hover:bg-transparent active:bg-transparent">
			<div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
				<ServerIcon size={16} />
			</div>
			<div className="grid flex-1 text-left text-sm leading-tight">
				<span className="truncate font-medium">Self Hosted</span>
			</div>
		</SidebarMenuButton>
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
