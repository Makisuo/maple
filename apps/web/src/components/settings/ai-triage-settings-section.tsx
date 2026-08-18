import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { useState } from "react"
import { Exit } from "effect"
import { toastManager } from "@maple/ui/components/ui/toast"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Switch } from "@maple/ui/components/ui/switch"
import { MapleInternalAtomClient, retainedInternalQuery } from "@/lib/services/common/internal-atom-client"
import { AiTriageSettingsUpdateRequest } from "@maple/domain/http"

interface AiTriageSettingsSectionProps {
	isAdmin: boolean
	hasEntitlement: boolean
}

const SETTINGS_REACTIVITY_KEYS = ["aiTriageSettings"]

/**
 * A number field that commits on blur and only when the value actually changed.
 *
 * Shared by both ceilings rather than written twice: the draft state, the parse,
 * the range guard and the no-op check are the same six lines, and the second copy
 * is where the two fields drift apart.
 */
function DailyLimitField({
	id,
	label,
	value,
	min,
	max,
	disabled,
	help,
	onCommit,
}: {
	id: string
	label: string
	value: number
	min: number
	max: number
	disabled: boolean
	help: React.ReactNode
	onCommit: (next: number) => void
}) {
	const [draft, setDraft] = useState<string | null>(null)
	return (
		<div className="space-y-2 sm:max-w-xs">
			<Label htmlFor={id}>{label}</Label>
			<Input
				id={id}
				type="number"
				min={min}
				max={max}
				disabled={disabled}
				value={draft ?? String(value)}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={() => {
					if (draft === null) return
					const parsed = Number.parseInt(draft, 10)
					setDraft(null)
					if (Number.isFinite(parsed) && parsed >= min && parsed <= max && parsed !== value) {
						onCommit(parsed)
					}
				}}
			/>
			<p className="text-xs text-muted-foreground">{help}</p>
		</div>
	)
}

export function AiTriageSettingsSection({ isAdmin, hasEntitlement }: AiTriageSettingsSectionProps) {
	const settingsQueryAtom = retainedInternalQuery("aiTriage", "getSettings", {
		reactivityKeys: SETTINGS_REACTIVITY_KEYS,
	})
	const settingsResult = useAtomValue(settingsQueryAtom)
	const refreshSettings = useAtomRefresh(settingsQueryAtom)

	const updateMutation = useAtomSet(MapleInternalAtomClient.mutation("aiTriage", "updateSettings"), {
		mode: "promiseExit",
	})

	const [isSaving, setIsSaving] = useState(false)

	if (!isAdmin || !hasEntitlement) {
		return null
	}

	const settings = Result.builder(settingsResult)
		.onSuccess((value) => value)
		.orElse(() => null)

	const save = async (request: AiTriageSettingsUpdateRequest, successMessage: string) => {
		setIsSaving(true)
		const result = await updateMutation({
			payload: request,
			reactivityKeys: SETTINGS_REACTIVITY_KEYS,
		})
		setIsSaving(false)
		if (Exit.isSuccess(result)) {
			toastManager.add({ title: successMessage, type: "success" })
		} else {
			toastManager.add({ title: "Failed to update AI triage settings.", type: "error" })
		}
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					AI auto-triage
					{settings?.enabled ? (
						<Badge variant="outline" className="bg-success/10 text-success">
							Enabled
						</Badge>
					) : null}
				</CardTitle>
				<CardDescription>
					When a new error or anomaly incident opens, an AI agent automatically investigates it with
					read-only tools and attaches a triage summary. Runs use Maple's managed AI — no setup
					required.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-6">
				{Result.builder(settingsResult)
					.onInitial(() => <Skeleton className="h-24 w-full" />)
					.onError(() => (
						<div className="flex items-center justify-between gap-4 py-2 text-sm text-muted-foreground">
							<span>Failed to load AI triage settings.</span>
							<Button size="sm" variant="outline" onClick={() => refreshSettings()}>
								Retry
							</Button>
						</div>
					))
					.onSuccess((current) => (
						<>
							<div className="flex items-center justify-between gap-4">
								<div className="space-y-0.5">
									<Label htmlFor="ai-triage-enabled">Auto-triage new incidents</Label>
									<p className="text-xs text-muted-foreground">
										Investigate each new incident automatically.
									</p>
								</div>
								<Switch
									id="ai-triage-enabled"
									checked={current.enabled}
									disabled={isSaving}
									onCheckedChange={(checked) =>
										save(
											new AiTriageSettingsUpdateRequest({ enabled: checked }),
											checked ? "AI auto-triage enabled" : "AI auto-triage disabled",
										)
									}
								/>
							</div>

							<DailyLimitField
								id="ai-triage-max-runs"
								label="Max investigations per day"
								value={current.maxRunsPerDay}
								min={1}
								max={500}
								disabled={isSaving}
								help="How many incidents auto-triage may investigate in a UTC day."
								onCommit={(parsed) =>
									save(
										new AiTriageSettingsUpdateRequest({ maxRunsPerDay: parsed }),
										"Daily run cap updated",
									)
								}
							/>

							<DailyLimitField
								id="ai-triage-max-passes"
								label="Max model passes per day"
								value={current.maxPassesPerDay}
								min={1}
								max={2000}
								disabled={isSaving}
								help="The spend ceiling. A planned investigation spends about six passes — planner, hypotheses, validator — so this is usually what stops triage first, whichever ceiling is reached first."
								onCommit={(parsed) =>
									save(
										new AiTriageSettingsUpdateRequest({ maxPassesPerDay: parsed }),
										"Daily model-pass cap updated",
									)
								}
							/>

							<p className="text-xs text-muted-foreground">
								Both ceilings apply to automatic triage only. Investigations you start or
								retry yourself are never blocked by them.
							</p>

							<div className="flex justify-end">
								<Button
									size="sm"
									variant="ghost"
									disabled={isSaving}
									onClick={() => refreshSettings()}
								>
									Refresh
								</Button>
							</div>
						</>
					))
					.render()}
			</CardContent>
		</Card>
	)
}
