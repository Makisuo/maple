import { Navigate, useNavigate, createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import {
	AccountNav,
	accountTabLabels,
	accountTabValues,
	resolveActiveAccountTab,
	type AccountTab,
} from "@/components/account/account-nav"
import { ProfileSection } from "@/components/account/profile-section"
import { EmailAddressesSection } from "@/components/account/email-addresses-section"
import { PasswordSection } from "@/components/account/password-section"
import { TwoFactorSection } from "@/components/account/two-factor-section"
import { PasskeysSection } from "@/components/account/passkeys-section"
import { ConnectedAccountsSection } from "@/components/account/connected-accounts-section"
import { ActiveSessionsSection } from "@/components/account/active-sessions-section"

const AccountSearch = Schema.Struct({
	tab: Schema.optional(Schema.Literals(accountTabValues)),
})

export const Route = createFileRoute("/account")({
	component: AccountPage,
	validateSearch: Schema.toStandardSchemaV1(AccountSearch),
})

function AccountPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	// Self-hosted mode has no user records — just a single `root` pseudo-user backed by
	// MAPLE_ROOT_PASSWORD — so there is nothing here to manage.
	if (!isClerkAuthEnabled) {
		return <Navigate to="/settings" replace />
	}

	const activeTab = resolveActiveAccountTab(search.tab)

	function handleTabSelect(tab: AccountTab) {
		navigate({ search: { tab } })
	}

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs
				items={[{ label: "Account", href: "/account" }, { label: accountTabLabels[activeTab] }]}
			/>
			<DashboardLayout.Body>
				<DashboardLayout.Filters>
					<AccountNav active={activeTab} onSelectTab={handleTabSelect} />
				</DashboardLayout.Filters>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header title={accountTabLabels[activeTab]} />
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>
						{activeTab === "profile" && <ProfileSection />}
						{activeTab === "emails" && <EmailAddressesSection />}
						{activeTab === "password" && <PasswordSection />}
						{activeTab === "two-factor" && <TwoFactorSection />}
						{activeTab === "passkeys" && <PasskeysSection />}
						{activeTab === "connections" && <ConnectedAccountsSection />}
						{activeTab === "sessions" && <ActiveSessionsSection />}
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}
