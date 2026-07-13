import { HazelStartConnectRequest, type AlertDestinationType } from "@maple/domain/http"
import {
	type DestinationFormState,
	defaultDestinationForm,
	MAX_EMAIL_MEMBER_RECIPIENTS,
} from "@/lib/alerts/form-utils"
import {
	DESTINATION_TYPES,
	PROVIDERS,
	ProviderLogo,
	type DestinationProvider,
} from "@/components/alerts/destination-provider"
import { HazelIcon, LoaderIcon } from "@/components/icons"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import type { HazelChannelsListResponse } from "@maple/domain/http"
import { Exit } from "effect"
import { useEffect, useState } from "react"
import { Button } from "@maple/ui/components/ui/button"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@maple/ui/components/ui/select"
import { Switch } from "@maple/ui/components/ui/switch"
import { Avatar, AvatarFallback, AvatarImage } from "@maple/ui/components/ui/avatar"
import { Checkbox } from "@maple/ui/components/ui/checkbox"
import { cn } from "@maple/ui/utils"
import { useOrganization } from "@clerk/clerk-react"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"

interface DestinationDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	form: DestinationFormState
	onFormChange: (updater: (current: DestinationFormState) => DestinationFormState) => void
	isEditing: boolean
	saving: boolean
	onSave: () => void
}

/**
 * A PagerDuty Events API v2 integration ("routing") key is exactly 32
 * alphanumeric characters. The common mistake is pasting a shorter REST API
 * token; this catches it before the server round-trip.
 */
const isValidPagerDutyKey = (key: string): boolean => /^[A-Za-z0-9]{32}$/.test(key.trim())

function isFormReady(form: DestinationFormState, isEditing: boolean): boolean {
	if (form.name.trim().length === 0) return false
	switch (form.type) {
		case "hazel-oauth":
			return form.hazelOrganizationId.trim().length > 0 && form.hazelChannelId.trim().length > 0
		// On create the secret is required; when editing, a blank value keeps the
		// stored one.
		case "discord":
			return isEditing || form.webhookUrl.trim().length > 0
		case "pagerduty":
			// Editing with a blank key keeps the stored one; otherwise require a
			// well-formed routing key.
			return isEditing && form.integrationKey.trim().length === 0
				? true
				: isValidPagerDutyKey(form.integrationKey)
		case "email":
			// The current selection is prefilled when editing, so a member is
			// always required.
			return (
				form.memberUserIds.length > 0 && form.memberUserIds.length <= MAX_EMAIL_MEMBER_RECIPIENTS
			)
		default:
			return true
	}
}

function ProviderTile({
	type,
	selected,
	onSelect,
}: {
	type: AlertDestinationType
	selected: boolean
	onSelect: () => void
}) {
	const provider = PROVIDERS[type]
	return (
		<button
			type="button"
			onClick={onSelect}
			aria-pressed={selected}
			className={cn(
				"group relative flex flex-col items-start gap-2 overflow-hidden rounded-lg border p-3 text-left transition-all",
				"hover:border-border/80 hover:bg-muted/40",
				selected
					? "border-transparent shadow-[inset_0_0_0_1.5px_var(--tile-accent)] bg-muted/40"
					: "border-border/60 bg-card",
			)}
			style={{ ["--tile-accent" as string]: provider.accent }}
		>
			<span
				aria-hidden
				className={cn(
					"pointer-events-none absolute inset-0 transition-opacity",
					selected ? "opacity-100" : "opacity-0 group-hover:opacity-60",
				)}
				style={{
					background: `radial-gradient(circle at 0% 0%, ${provider.accentBg}, transparent 60%)`,
				}}
			/>
			<div className="relative flex w-full items-center gap-2.5">
				<ProviderLogo type={type} size={32} />
				<span className="text-sm font-semibold">{provider.label}</span>
			</div>
			<p className="relative text-[11px] leading-snug text-muted-foreground">{provider.description}</p>
		</button>
	)
}

/**
 * Workspace-member recipient picker. Members come from Clerk's frontend
 * memberships hook — the server re-resolves the selected ids to emails via the
 * Clerk backend on save, so this list is a convenience, not a trust boundary.
 */
function EmailMemberPicker({
	form,
	onFormChange,
}: {
	form: DestinationFormState
	onFormChange: (updater: (current: DestinationFormState) => DestinationFormState) => void
}) {
	const { memberships, isLoaded } = useOrganization({ memberships: { infinite: true } })
	const members = memberships?.data ?? []

	const toggleMember = (userId: string) =>
		onFormChange((current) => ({
			...current,
			memberUserIds: current.memberUserIds.includes(userId)
				? current.memberUserIds.filter((id) => id !== userId)
				: [...current.memberUserIds, userId],
		}))

	return (
		<div className="space-y-1.5">
			<Label className="text-xs">Recipients</Label>
			<div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border border-border/60 p-1">
				{!isLoaded && (
					<p className="px-2 py-1.5 text-[11px] text-muted-foreground">Loading members…</p>
				)}
				{isLoaded && members.length === 0 && (
					<p className="px-2 py-1.5 text-[11px] text-muted-foreground">
						No members found in this workspace.
					</p>
				)}
				{members.map((member) => {
					const userId = member.publicUserData?.userId
					const email = member.publicUserData?.identifier
					if (!userId || !email) return null
					const name = [member.publicUserData?.firstName, member.publicUserData?.lastName]
						.filter(Boolean)
						.join(" ")
					const checked = form.memberUserIds.includes(userId)
					return (
						<label
							key={userId}
							className={cn(
								"flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 hover:bg-muted/40",
								checked && "bg-muted/40",
							)}
						>
							<Checkbox checked={checked} onCheckedChange={() => toggleMember(userId)} />
							<Avatar className="size-6">
								<AvatarImage src={member.publicUserData?.imageUrl} alt={name || email} />
								<AvatarFallback>{(name || email)[0]?.toUpperCase() ?? "?"}</AvatarFallback>
							</Avatar>
							<span className="min-w-0 flex-1">
								<span className="block truncate text-xs font-medium">{name || email}</span>
								{name && (
									<span className="block truncate text-[11px] text-muted-foreground">
										{email}
									</span>
								)}
							</span>
						</label>
					)
				})}
				{memberships?.hasNextPage && (
					<Button
						variant="ghost"
						size="sm"
						className="w-full text-xs"
						onClick={() => memberships.fetchNext?.()}
					>
						Load more
					</Button>
				)}
			</div>
			<p className="text-[11px] text-muted-foreground">
				Alert emails go to the selected workspace members (up to {MAX_EMAIL_MEMBER_RECIPIENTS}).
			</p>
			{form.memberUserIds.length > MAX_EMAIL_MEMBER_RECIPIENTS && (
				<p className="text-[11px] text-destructive">
					Select at most {MAX_EMAIL_MEMBER_RECIPIENTS} members.
				</p>
			)}
		</div>
	)
}

function HazelOrgAvatar({
	logoUrl,
	name,
	size = 16,
}: {
	logoUrl: string | null
	name: string
	size?: number
}) {
	const [errored, setErrored] = useState(false)
	if (logoUrl && !errored) {
		return (
			<img
				src={logoUrl}
				alt={`${name} logo`}
				width={size}
				height={size}
				loading="lazy"
				referrerPolicy="no-referrer"
				onError={() => setErrored(true)}
				className="shrink-0 rounded-sm object-cover"
				style={{ width: size, height: size }}
			/>
		)
	}
	// Fallback: a tinted square with the Hazel mark, mirroring ProviderLogo's
	// visual language but at compact size.
	const inner = Math.round(size * 0.7)
	return (
		<span
			className="flex shrink-0 items-center justify-center rounded-sm"
			style={{
				width: size,
				height: size,
				background: "rgba(244,111,15,0.16)",
				color: "#F46F0F",
			}}
		>
			<HazelIcon size={inner} />
		</span>
	)
}

function HazelOAuthFields({
	form,
	onFormChange,
	isEditing,
}: {
	form: DestinationFormState
	onFormChange: (updater: (current: DestinationFormState) => DestinationFormState) => void
	isEditing: boolean
}) {
	const statusResult = useAtomValue(
		MapleApiAtomClient.query("integrations", "hazelStatus", {
			reactivityKeys: ["hazelIntegrationStatus"],
		}),
	)
	const organizationsAtom = MapleApiAtomClient.query("integrations", "hazelOrganizations", {
		reactivityKeys: ["hazelIntegrationStatus", "hazelOrganizations"],
	})
	const organizationsResult = useAtomValue(organizationsAtom)

	const orgIdForChannels = form.hazelOrganizationId.trim()
	const channelsAtom =
		orgIdForChannels.length > 0
			? MapleApiAtomClient.query("integrations", "hazelChannels", {
					params: { organizationId: orgIdForChannels },
					reactivityKeys: ["hazelIntegrationStatus", "hazelChannels", orgIdForChannels],
				})
			: disabledResultAtom<HazelChannelsListResponse>()
	const channelsResult = useAtomValue(channelsAtom)

	const startConnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "hazelStart"), {
		mode: "promiseExit",
	})
	const disconnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "hazelDisconnect"), {
		mode: "promiseExit",
	})

	const [busy, setBusy] = useState(false)

	const status = Result.builder(statusResult)
		.onSuccess((s) => s)
		.orElse(() => null)

	const organizations = Result.builder(organizationsResult)
		.onSuccess((o) => [...o.organizations])
		.orElse(() => [] as Array<{ id: string; name: string; slug: string | null; logoUrl: string | null }>)

	const channels = Result.builder(channelsResult)
		.onSuccess((c) => [...c.channels])
		.orElse(
			() =>
				[] as Array<{ id: string; name: string; type: "public" | "private"; organizationId: string }>,
		)
	const channelsLoading = orgIdForChannels.length > 0 && channelsResult.waiting

	// Surface failures explicitly. Without these, an OAuth/API error renders
	// identically to "not connected" / "no data", silently hiding the problem.
	const statusFailed = Result.isFailure(statusResult)
	const organizationsFailed = Result.isFailure(organizationsResult)
	const channelsFailed = Result.isFailure(channelsResult)

	useEffect(() => {
		function onMessage(event: MessageEvent) {
			if (event.data && event.data.type === "maple:integration:hazel") {
				// Bust by toggling form state so the reactivity-keyed atoms refetch.
				onFormChange((current) => ({ ...current }))
			}
		}
		window.addEventListener("message", onMessage)
		return () => window.removeEventListener("message", onMessage)
	}, [onFormChange])

	async function handleConnect() {
		// Open the popup synchronously to satisfy popup-blocker user-gesture rules,
		// then point it at the OAuth URL once the start mutation returns.
		const popup = window.open("", "maple-hazel-connect", "popup,width=520,height=640")
		setBusy(true)
		const result = await startConnect({
			payload: new HazelStartConnectRequest({ returnTo: window.location.href }),
			reactivityKeys: ["hazelIntegrationStatus"],
		})
		setBusy(false)
		if (Exit.isSuccess(result)) {
			const url = result.value.redirectUrl
			if (popup) popup.location.href = url
			else window.open(url, "maple-hazel-connect", "popup,width=520,height=640")
		} else {
			popup?.close()
		}
	}

	async function handleDisconnect() {
		setBusy(true)
		await disconnect({
			reactivityKeys: ["hazelIntegrationStatus", "hazelOrganizations", "hazelChannels"],
		})
		setBusy(false)
		onFormChange((current) => ({
			...current,
			hazelOrganizationId: "",
			hazelOrganizationName: "",
			hazelOrganizationLogoUrl: null,
			hazelChannelId: "",
			hazelChannelName: "",
		}))
	}

	if (!status || !status.connected) {
		return (
			<div className="space-y-2 rounded-md border border-dashed border-border/60 p-3">
				{statusFailed ? (
					<p className="text-xs text-destructive">
						Couldn't check your Hazel connection status. This may be a temporary issue — try
						connecting again.
					</p>
				) : null}
				<p className="text-xs text-muted-foreground">
					Connect Maple to your Hazel account via OAuth. We'll fetch the organizations and channels
					you can post into and provision a dedicated webhook for this destination.
				</p>
				<Button
					type="button"
					size="sm"
					onClick={handleConnect}
					disabled={busy}
					style={{ background: "#F46F0F", borderColor: "#F46F0F", color: "#fff" }}
				>
					{busy ? <LoaderIcon size={14} className="animate-spin" /> : null}
					Connect Hazel
				</Button>
			</div>
		)
	}

	const selectedOrg = organizations.find((o) => o.id === form.hazelOrganizationId)
	const selectedOrgLogoUrl = selectedOrg?.logoUrl ?? form.hazelOrganizationLogoUrl ?? null
	const selectedOrgName = selectedOrg?.name ?? form.hazelOrganizationName ?? ""

	const orgSelectItems = organizations.map((o) => ({ value: o.id, label: o.name }))
	const channelSelectItems = channels.map((c) => ({
		value: c.id,
		label: c.type === "private" ? `${c.name} (private)` : c.name,
	}))

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-xs">
				<div className="space-y-0.5">
					<div className="font-medium">Connected to Hazel</div>
					<div className="text-muted-foreground">
						{status.externalUserEmail ?? status.externalUserId ?? "Authorized"}
					</div>
				</div>
				<Button type="button" size="sm" variant="outline" onClick={handleDisconnect} disabled={busy}>
					Disconnect
				</Button>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor="destination-hazel-organization" className="text-xs">
					Hazel organization
				</Label>
				<Select
					items={orgSelectItems}
					defaultValue={form.hazelOrganizationId || null}
					onValueChange={(value) => {
						const org = organizations.find((o) => o.id === value)
						onFormChange((current) => ({
							...current,
							hazelOrganizationId: value ?? "",
							hazelOrganizationName: org?.name ?? "",
							hazelOrganizationLogoUrl: org?.logoUrl ?? null,
							// Reset channel when org changes.
							hazelChannelId: "",
							hazelChannelName: "",
						}))
					}}
				>
					<SelectTrigger id="destination-hazel-organization" className="w-full">
						{selectedOrgName ? (
							<span className="flex items-center gap-2">
								<HazelOrgAvatar logoUrl={selectedOrgLogoUrl} name={selectedOrgName} />
								<span className="truncate">{selectedOrgName}</span>
							</span>
						) : (
							<SelectValue placeholder="Pick an organization" />
						)}
					</SelectTrigger>
					<SelectContent>
						<SelectGroup>
							{organizations.map((org) => (
								<SelectItem key={org.id} value={org.id}>
									<span className="flex items-center gap-2">
										<HazelOrgAvatar logoUrl={org.logoUrl} name={org.name} />
										<span className="truncate">{org.name}</span>
									</span>
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
				{organizationsFailed ? (
					<p className="text-[11px] text-destructive">
						Couldn't load your Hazel organizations. Try reconnecting or refreshing.
					</p>
				) : organizations.length === 0 ? (
					<p className="text-[11px] text-muted-foreground">
						No organizations returned. Make sure your Hazel account is a member of at least one
						organization.
					</p>
				) : null}
			</div>
			<div className="space-y-1.5">
				<Label htmlFor="destination-hazel-channel" className="text-xs">
					Hazel channel
				</Label>
				<Select
					items={channelSelectItems}
					defaultValue={form.hazelChannelId || null}
					onValueChange={(value) => {
						const ch = channels.find((c) => c.id === value)
						onFormChange((current) => ({
							...current,
							hazelChannelId: value ?? "",
							hazelChannelName: ch?.name ?? current.hazelChannelName,
						}))
					}}
					disabled={orgIdForChannels.length === 0 || channelsLoading}
				>
					<SelectTrigger id="destination-hazel-channel" className="w-full">
						<SelectValue
							placeholder={
								orgIdForChannels.length === 0
									? "Pick an organization first"
									: channelsLoading
										? "Loading channels…"
										: isEditing && form.hazelChannelName
											? `#${form.hazelChannelName}`
											: "Pick a channel"
							}
						/>
					</SelectTrigger>
					<SelectContent>
						<SelectGroup>
							{channelSelectItems.map((item) => (
								<SelectItem key={item.value} value={item.value}>
									#{item.label}
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
				{orgIdForChannels.length > 0 && !channelsLoading && channelsFailed ? (
					<p className="text-[11px] text-destructive">
						Couldn't load channels for this organization. Try reselecting the organization.
					</p>
				) : orgIdForChannels.length > 0 && !channelsLoading && channels.length === 0 ? (
					<p className="text-[11px] text-muted-foreground">
						No channels. Make sure your account is in at least one channel of this organization.
					</p>
				) : null}
			</div>
		</div>
	)
}

function FieldHelper({ provider }: { provider: DestinationProvider }) {
	if (!provider.docsUrl) return null
	return (
		<a
			href={provider.docsUrl}
			target="_blank"
			rel="noreferrer"
			className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
		>
			{provider.docsLabel ?? "Docs"} ↗
		</a>
	)
}

export function DestinationDialog({
	open,
	onOpenChange,
	form,
	onFormChange,
	isEditing,
	saving,
	onSave,
}: DestinationDialogProps) {
	const provider = PROVIDERS[form.type]

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2.5">
						{isEditing ? <ProviderLogo type={form.type} size={28} /> : null}
						{isEditing ? `Edit ${provider.label} destination` : "Add destination"}
					</DialogTitle>
					<DialogDescription>
						Reuse the same destination across alert rules and verify it with synthetic test
						events.
					</DialogDescription>
				</DialogHeader>

				{/* DialogContent is a viewport-capped flex column; the body scrolls so
				    the header and footer stay pinned when the form outgrows the screen. */}
				<div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6">
					{!isEditing && (
						<div className="space-y-2">
							<div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
								Provider
							</div>
							<div className="grid grid-cols-2 gap-2">
								{DESTINATION_TYPES.map((type) => (
									<ProviderTile
										key={type}
										type={type}
										selected={form.type === type}
										onSelect={() => onFormChange(() => defaultDestinationForm(type))}
									/>
								))}
							</div>
						</div>
					)}

					<div className="space-y-2">
						<div className="flex items-center justify-between">
							<div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
								Connection
							</div>
							<FieldHelper provider={provider} />
						</div>
						<div className="space-y-3 rounded-lg border border-border/60 bg-card p-4">
							<div className="space-y-1.5">
								<Label htmlFor="destination-name" className="text-xs">
									Name
								</Label>
								<Input
									id="destination-name"
									value={form.name}
									onChange={(event) =>
										onFormChange((current) => ({ ...current, name: event.target.value }))
									}
									placeholder="Production paging"
								/>
							</div>

							{form.type === "slack" && (
								<>
									<div className="space-y-1.5">
										<Label htmlFor="destination-webhook" className="text-xs">
											Slack webhook URL
										</Label>
										<Input
											id="destination-webhook"
											value={form.webhookUrl}
											onChange={(event) =>
												onFormChange((current) => ({
													...current,
													webhookUrl: event.target.value,
												}))
											}
											placeholder={
												isEditing
													? "Leave blank to keep current webhook"
													: "https://hooks.slack.com/services/..."
											}
											className="font-mono text-xs"
										/>
									</div>
									<div className="space-y-1.5">
										<Label htmlFor="destination-channel" className="text-xs">
											Channel label
										</Label>
										<Input
											id="destination-channel"
											value={form.channelLabel}
											onChange={(event) =>
												onFormChange((current) => ({
													...current,
													channelLabel: event.target.value,
												}))
											}
											placeholder="#ops-alerts"
											className="font-mono text-xs"
										/>
									</div>
								</>
							)}

							{form.type === "pagerduty" && (
								<div className="space-y-1.5">
									<Label htmlFor="destination-integration" className="text-xs">
										Integration key
									</Label>
									<Input
										id="destination-integration"
										value={form.integrationKey}
										onChange={(event) =>
											onFormChange((current) => ({
												...current,
												integrationKey: event.target.value,
											}))
										}
										placeholder={
											isEditing
												? "Leave blank to keep current key"
												: "e.g. R0XXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
										}
										className="font-mono text-xs"
									/>
									{form.integrationKey.trim().length > 0 &&
										!isValidPagerDutyKey(form.integrationKey) && (
											<p className="text-[11px] text-destructive">
												That isn't a routing key (must be 32 characters). A
												~20-character REST API token won't work — copy the Events API
												v2 integration key.
											</p>
										)}
									<p className="text-[11px] text-muted-foreground">
										In PagerDuty: open the service → Integrations → add or select an{" "}
										<a
											href="https://maple.dev/docs/alerting/notification-destinations#pagerduty"
											target="_blank"
											rel="noreferrer"
											className="underline-offset-2 hover:text-foreground hover:underline"
										>
											Events API v2
										</a>{" "}
										integration → copy its Integration Key (32 characters). A REST API
										token won't work.
									</p>
								</div>
							)}

							{form.type === "discord" && (
								<div className="space-y-1.5">
									<Label htmlFor="destination-discord-webhook" className="text-xs">
										Discord webhook URL
									</Label>
									<Input
										id="destination-discord-webhook"
										value={form.webhookUrl}
										onChange={(event) =>
											onFormChange((current) => ({
												...current,
												webhookUrl: event.target.value,
											}))
										}
										placeholder={
											isEditing
												? "Leave blank to keep current webhook"
												: "https://discord.com/api/webhooks/..."
										}
										className="font-mono text-xs"
									/>
									<p className="text-[11px] text-muted-foreground">
										In Discord: Channel settings → Integrations → Webhooks → New Webhook,
										then copy the URL.
									</p>
								</div>
							)}

							{form.type === "webhook" && (
								<>
									<div className="space-y-1.5">
										<Label htmlFor="destination-url" className="text-xs">
											Webhook URL
										</Label>
										<Input
											id="destination-url"
											value={form.url}
											onChange={(event) =>
												onFormChange((current) => ({
													...current,
													url: event.target.value,
												}))
											}
											placeholder={
												isEditing
													? "Leave blank to keep current URL"
													: "https://example.com/maple-alerts"
											}
											className="font-mono text-xs"
										/>
									</div>
									<div className="space-y-1.5">
										<Label htmlFor="destination-secret" className="text-xs">
											Signing secret
										</Label>
										<Input
											id="destination-secret"
											value={form.signingSecret}
											onChange={(event) =>
												onFormChange((current) => ({
													...current,
													signingSecret: event.target.value,
												}))
											}
											placeholder={
												isEditing
													? "Leave blank to keep current secret"
													: "Optional HMAC secret"
											}
											className="font-mono text-xs"
										/>
									</div>
								</>
							)}

							{form.type === "email" &&
								(isClerkAuthEnabled ? (
									<EmailMemberPicker form={form} onFormChange={onFormChange} />
								) : (
									<p className="text-[11px] text-muted-foreground">
										Email destinations target workspace members and require Clerk
										authentication, which is not enabled in this deployment.
									</p>
								))}

							{form.type === "hazel-oauth" && (
								<HazelOAuthFields
									form={form}
									onFormChange={onFormChange}
									isEditing={isEditing}
								/>
							)}

							{form.type === "hazel" && (
								<>
									<div className="space-y-1.5">
										<Label htmlFor="destination-hazel-url" className="text-xs">
											Hazel webhook URL
										</Label>
										<Input
											id="destination-hazel-url"
											value={form.hazelWebhookUrl}
											onChange={(event) =>
												onFormChange((current) => ({
													...current,
													hazelWebhookUrl: event.target.value,
												}))
											}
											placeholder={
												isEditing
													? "Leave blank to keep current URL"
													: "https://api.hazel.sh/webhooks/incoming/{webhookId}/{token}/maple"
											}
											className="font-mono text-xs"
										/>
										<p className="text-[11px] text-muted-foreground">
											Create a Maple webhook in Hazel under Settings → Integrations →
											Maple, then paste the URL here.
										</p>
									</div>
									<div className="space-y-1.5">
										<Label htmlFor="destination-hazel-secret" className="text-xs">
											Signing secret
										</Label>
										<Input
											id="destination-hazel-secret"
											value={form.signingSecret}
											onChange={(event) =>
												onFormChange((current) => ({
													...current,
													signingSecret: event.target.value,
												}))
											}
											placeholder={
												isEditing
													? "Leave blank to keep current secret"
													: "Optional HMAC secret"
											}
											className="font-mono text-xs"
										/>
									</div>
								</>
							)}
						</div>
					</div>

					<div className="space-y-2">
						<div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
							Delivery
						</div>
						<div className="flex items-center justify-between rounded-lg border border-border/60 bg-card px-4 py-3">
							<div>
								<div className="text-sm font-medium">Enabled</div>
								<div className="text-[11px] text-muted-foreground">
									Disabled destinations stay attached to rules but won't receive
									notifications.
								</div>
							</div>
							<Switch
								checked={form.enabled}
								onCheckedChange={(enabled) =>
									onFormChange((current) => ({ ...current, enabled }))
								}
							/>
						</div>
					</div>
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						onClick={onSave}
						disabled={saving || !isFormReady(form, isEditing)}
						style={{
							background: provider.accent,
							borderColor: provider.accent,
							color: "#fff",
						}}
					>
						{saving ? <LoaderIcon size={14} className="animate-spin" /> : null}
						{isEditing ? "Save changes" : `Create ${provider.label} destination`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
