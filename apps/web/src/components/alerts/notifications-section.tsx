import { useState, type Dispatch, type SetStateAction } from "react"
import { Link } from "@tanstack/react-router"

import { ALERT_TEMPLATE_VARIABLES, type AlertDestinationDocument } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Card } from "@maple/ui/components/ui/card"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { Textarea } from "@maple/ui/components/ui/textarea"

import {
	AlertMultiSegmentedSelect,
	type AlertSegmentedOption,
} from "@/components/alerts/alert-segmented-select"
import { ProviderLogo } from "@/components/alerts/destination-provider"
import { SectionLabel } from "@/components/alerts/signal-and-threshold-section"
import { destinationTypeLabels, type RuleFormState } from "@/lib/alerts/form-utils"
import { ChevronDownIcon, ChevronRightIcon, LoaderIcon, PaperPlaneIcon } from "@/components/icons"

interface NotificationsSectionProps {
	form: RuleFormState
	onChange: Dispatch<SetStateAction<RuleFormState>>
	destinations: AlertDestinationDocument[]
	onSendTest: () => void
	testing: boolean
}

const TITLE_PLACEHOLDER = "{{ event.emoji }} {{ rule.name }} — {{ event.label }}"
const BODY_PLACEHOLDER = [
	// Only variables listed in ALERT_TEMPLATE_VARIABLES belong here — the
	// placeholder doubles as the reference for what's available.
	"{{ signal.label }} is *{{ value }}* ({{ comparator.label }} {{ threshold }}) over the last {{ window }}.",
	"*Severity:* {{ severity }} · *Group:* {{ group }}",
].join("\n")

/**
 * Pick which destinations receive this rule's notifications, plus an optional
 * "Send test notification" that actually dispatches through the selected
 * channel(s). The hero's Test Rule button performs a no-notification preview;
 * this one is the destructive-ish "really send it" path.
 */
export function NotificationsSection({
	form,
	onChange,
	destinations,
	onSendTest,
	testing,
}: NotificationsSectionProps) {
	const hasDestinations = destinations.length > 0
	const hasSelection = form.destinationIds.length > 0
	const hasTemplate = form.notificationTitle.length > 0 || form.notificationBody.length > 0
	const [templateOpen, setTemplateOpen] = useState(hasTemplate)

	const appendToBody = (token: string) =>
		onChange((c) => ({
			...c,
			notificationBody: c.notificationBody.length > 0 ? `${c.notificationBody} ${token}` : token,
		}))

	return (
		<Card className="p-4">
			<div className="flex items-center justify-between gap-3">
				<SectionLabel>Notifications</SectionLabel>
				{hasDestinations && (
					<Button
						variant="ghost"
						size="sm"
						onClick={onSendTest}
						disabled={!hasSelection || testing}
						className="h-7 px-2 text-xs"
					>
						{testing ? (
							<LoaderIcon size={12} className="animate-spin" />
						) : (
							<PaperPlaneIcon size={12} />
						)}
						Send test
					</Button>
				)}
			</div>

			<div className="mt-3">
				{!hasDestinations ? (
					<p className="text-muted-foreground text-sm">
						No destinations yet.{" "}
						<Link
							to="/alerts"
							search={{ tab: "settings" }}
							className="underline underline-offset-4 hover:text-foreground"
						>
							Create one in Settings
						</Link>{" "}
						before saving.
					</p>
				) : (
					<AlertMultiSegmentedSelect<string>
						options={
							destinations.map((d) => ({
								value: d.id as unknown as string,
								icon: <ProviderLogo type={d.type} size={24} bare />,
								label: (
									<span className="flex items-center gap-2">
										<span className="font-medium">{d.name}</span>
										<span className="text-muted-foreground text-xs">
											{destinationTypeLabels[d.type]}
										</span>
									</span>
								),
							})) satisfies AlertSegmentedOption<string>[]
						}
						value={form.destinationIds as unknown as string[]}
						onChange={(values) =>
							onChange((c) => ({
								...c,
								destinationIds: values as typeof c.destinationIds,
							}))
						}
						aria-label="Notification destinations"
						size="sm"
					/>
				)}
			</div>

			{/* Message template — optional {{ variable }} customization. */}
			<div className="mt-4 border-t border-border/60 pt-3">
				<button
					type="button"
					onClick={() => setTemplateOpen((open) => !open)}
					className="flex w-full items-center justify-between gap-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
					aria-expanded={templateOpen}
				>
					<span className="flex items-center gap-1.5">
						{templateOpen ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
						Message template
					</span>
					{hasTemplate && !templateOpen && (
						<span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
							Customized
						</span>
					)}
				</button>

				{templateOpen && (
					<div className="mt-3 space-y-3">
						<p className="text-muted-foreground text-xs">
							Customize the Slack / Discord / PagerDuty message. Leave blank to use Maple's
							default format. Supports{" "}
							<code className="rounded bg-muted px-1">{"{{ variable }}"}</code> substitution.
						</p>

						<div className="space-y-1.5">
							<Label htmlFor="notification-title" className="text-xs">
								Title
							</Label>
							<Input
								id="notification-title"
								value={form.notificationTitle}
								onChange={(e) =>
									onChange((c) => ({ ...c, notificationTitle: e.target.value }))
								}
								placeholder={TITLE_PLACEHOLDER}
							/>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="notification-body" className="text-xs">
								Body (Markdown)
							</Label>
							<Textarea
								id="notification-body"
								value={form.notificationBody}
								onChange={(e) =>
									onChange((c) => ({ ...c, notificationBody: e.target.value }))
								}
								placeholder={BODY_PLACEHOLDER}
								rows={4}
								className="font-mono text-xs"
							/>
						</div>

						<div className="space-y-1.5">
							<span className="text-muted-foreground text-[11px]">Insert a variable:</span>
							<div className="flex flex-wrap gap-1">
								{ALERT_TEMPLATE_VARIABLES.map((variable) => (
									<button
										key={variable.key}
										type="button"
										title={variable.description}
										onClick={() => appendToBody(`{{ ${variable.key} }}`)}
										className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-border hover:text-foreground"
									>
										{variable.key}
									</button>
								))}
							</div>
						</div>
					</div>
				)}
			</div>
		</Card>
	)
}
