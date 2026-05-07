import { useClerk, useOrganization, useUser } from "@clerk/clerk-react"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { ChevronExpandYIcon, LogoutIcon } from "@/components/icons"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { clearSelfHostedSessionToken } from "@/lib/services/common/self-hosted-auth"
import { ClerkOrgSwitcherMenu, OrgAvatar } from "@/components/dashboard/org-switcher-menu"

const PILL_BASE =
	"inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-2 py-1 text-xs font-medium text-foreground/90 shadow-sm transition-colors hover:bg-accent/60 data-[state=open]:bg-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"

export function OnboardingOrgSwitcher() {
	if (!isClerkAuthEnabled) return null
	return <OnboardingOrgSwitcherInner />
}

function OnboardingOrgSwitcherInner() {
	const { organization, isLoaded } = useOrganization()

	if (!isLoaded) return null

	const orgName = organization?.name ?? "Select organization"
	const orgImageUrl = organization?.imageUrl

	return (
		<ClerkOrgSwitcherMenu
			contentSide="bottom"
			contentAlign="end"
			trigger={
				<button type="button" className={PILL_BASE}>
					<OrgAvatar name={orgName} imageUrl={orgImageUrl} className="size-5" />
					<span className="max-w-[10rem] truncate">{orgName}</span>
					<ChevronExpandYIcon size={12} className="ml-0.5 text-muted-foreground" />
				</button>
			}
		/>
	)
}

export function OnboardingUserMenu() {
	if (isClerkAuthEnabled) return <ClerkUserMenu />
	return <SelfHostedUserMenu />
}

function ClerkUserMenu() {
	const { user, isLoaded } = useUser()
	const { signOut } = useClerk()

	if (!isLoaded) return null

	const name = user?.fullName ?? "Account"
	const email = user?.primaryEmailAddress?.emailAddress ?? ""
	const imageUrl = user?.imageUrl
	const initial = name.charAt(0).toUpperCase()

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<button type="button" className={`${PILL_BASE} pl-1 pr-2`} aria-label="Account menu">
						<UserAvatar imageUrl={imageUrl} initial={initial} name={name} />
						<span className="sr-only">Account menu</span>
					</button>
				}
			/>
			<DropdownMenuContent side="bottom" align="end" sideOffset={4} className="min-w-56">
				<DropdownMenuGroup>
					<DropdownMenuLabel>
						<div className="flex items-center gap-2 py-1 text-left text-sm">
							<UserAvatar imageUrl={imageUrl} initial={initial} name={name} />
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
					<DropdownMenuItem onClick={() => signOut()}>
						<LogoutIcon size={16} />
						Log out
					</DropdownMenuItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function SelfHostedUserMenu() {
	const handleLogout = () => {
		clearSelfHostedSessionToken()
		window.location.assign("/sign-in")
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<button type="button" className={`${PILL_BASE} pl-1 pr-2`} aria-label="Account menu">
						<UserAvatar initial="U" name="User" />
						<span className="sr-only">Account menu</span>
					</button>
				}
			/>
			<DropdownMenuContent side="bottom" align="end" sideOffset={4} className="min-w-44">
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

function UserAvatar({
	imageUrl,
	initial,
	name,
}: {
	imageUrl?: string
	initial: string
	name: string
}) {
	return imageUrl ? (
		<img src={imageUrl} alt={name} className="size-5 shrink-0 rounded-md object-cover" />
	) : (
		<div className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground text-[10px] font-semibold">
			{initial}
		</div>
	)
}
