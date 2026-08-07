import {
	ComputerIcon,
	EnvelopeIcon,
	FingerprintIcon,
	LinkIcon,
	LockIcon,
	ShieldIcon,
	UserIcon,
} from "@/components/icons"
import { SettingsNavShell, type NavShellSection } from "@/components/settings/settings-nav-shell"

export const accountTabValues = [
	"profile",
	"emails",
	"password",
	"two-factor",
	"passkeys",
	"connections",
	"sessions",
] as const
export type AccountTab = (typeof accountTabValues)[number]

export const accountTabLabels: Record<AccountTab, string> = {
	profile: "Profile",
	emails: "Email Addresses",
	password: "Password",
	"two-factor": "Two-Factor Auth",
	passkeys: "Passkeys",
	connections: "Connected Accounts",
	sessions: "Active Sessions",
}

/**
 * Landing tab when `/account` is opened with no `?tab=`. Unlike `/settings`, every account tab is
 * visible to any signed-in user, so this is a single value rather than a preference order — there
 * is no permission filtering that could make it unavailable.
 */
export const DEFAULT_ACCOUNT_TAB: AccountTab = "profile"

export const accountNavSections: ReadonlyArray<NavShellSection<AccountTab>> = [
	{
		id: "profile",
		title: "Profile",
		items: [
			{ id: "profile", label: accountTabLabels.profile, icon: UserIcon },
			{ id: "emails", label: accountTabLabels.emails, icon: EnvelopeIcon },
		],
	},
	{
		id: "security",
		title: "Security",
		items: [
			{ id: "password", label: accountTabLabels.password, icon: LockIcon },
			{ id: "two-factor", label: accountTabLabels["two-factor"], icon: ShieldIcon },
			{ id: "passkeys", label: accountTabLabels.passkeys, icon: FingerprintIcon },
		],
	},
	{
		id: "access",
		title: "Access",
		items: [
			{ id: "connections", label: accountTabLabels.connections, icon: LinkIcon },
			{ id: "sessions", label: accountTabLabels.sessions, icon: ComputerIcon },
		],
	},
]

/** Which tab `/account` should render: the requested one when it is a real tab, else the default. */
export function resolveActiveAccountTab(requestedTab: string | undefined): AccountTab {
	return accountTabValues.find((tab) => tab === requestedTab) ?? DEFAULT_ACCOUNT_TAB
}

export function AccountNav({
	active,
	onSelectTab,
}: {
	active: AccountTab
	onSelectTab: (tab: AccountTab) => void
}) {
	return <SettingsNavShell sections={accountNavSections} active={active} onSelectTab={onSelectTab} />
}
