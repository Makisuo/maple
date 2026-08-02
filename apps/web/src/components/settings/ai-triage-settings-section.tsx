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
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { AiTriageSettingsUpdateRequest } from "@maple/domain/http"

interface AiTriageSettingsSectionProps {
	isAdmin: boolean
	hasEntitlement: boolean
}

const SETTINGS_REACTIVITY_KEYS = ["aiTriageSettings"]

export function AiTriageSettingsSection({ isAdmin, hasEntitlement }: AiTriageSettingsSectionProps) {
	const settingsQueryAtom = MapleApiAtomClient.query("aiTriage", "getSettings", {
		reactivityKeys: SETTINGS_REACTIVITY_KEYS,
	})
	const settingsResult = useAtomValue(settingsQueryAtom)
	const refreshSettings = useAtomRefresh(settingsQueryAtom)

	const updateMutation = useAtomSet(MapleApiAtomClient.mutation("aiTriage", "updateSettings"), {
		mode: "promiseExit",
	})

	const [isSaving, setIsSaving] = useState(false)
	const [maxRunsDraft, setMaxRunsDraft] = useState<string | null>(null)

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

							<div className="space-y-2 sm:max-w-xs">
								<Label htmlFor="ai-triage-max-runs">Max runs per day</Label>
								<Input
									id="ai-triage-max-runs"
									type="number"
									min={1}
									max={500}
									value={maxRunsDraft ?? String(current.maxRunsPerDay)}
									onChange={(event) => setMaxRunsDraft(event.target.value)}
									onBlur={() => {
										if (maxRunsDraft === null) return
										const parsed = Number.parseInt(maxRunsDraft, 10)
										setMaxRunsDraft(null)
										if (
											Number.isFinite(parsed) &&
											parsed >= 1 &&
											parsed <= 500 &&
											parsed !== current.maxRunsPerDay
										) {
											save(
												new AiTriageSettingsUpdateRequest({
													maxRunsPerDay: parsed,
												}),
												"Daily run cap updated",
											)
										}
									}}
								/>
								<p className="text-xs text-muted-foreground">
									Bounds LLM spend — additional incidents skip triage once reached.
								</p>
							</div>

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
