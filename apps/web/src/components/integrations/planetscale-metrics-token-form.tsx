import { useState } from "react"
import { Cause, Exit } from "effect"

import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { toastManager } from "@maple/ui/components/ui/toast"

import { ExternalLinkIcon, LoaderIcon } from "@/components/icons"
import { useAtomSet } from "@/lib/effect-atom"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"

/** PlanetScale prints service token secrets with this prefix. Advisory, not a contract. */
const SECRET_PREFIX = "pscale_tkn_"

/**
 * Where PlanetScale mints service tokens. Deep-linking to the exact page is the
 * difference between a 30-second step and a hunt through settings.
 */
const tokenSettingsUrl = (organization: string) =>
	`https://app.planetscale.com/${encodeURIComponent(organization)}/settings/service-tokens`

interface TokenFields {
	readonly id: string
	readonly secret: string
}

/**
 * PlanetScale's UI hands the token out as a single `id:secret` line, and people
 * paste the whole thing into whichever field has focus. Rather than reject that,
 * split it. Also handles the secret being pasted into the id field on its own.
 */
export function normalizeTokenPaste(
	field: "id" | "secret",
	pasted: string,
	current: TokenFields,
): TokenFields {
	const value = pasted.trim()
	if (value === "") return current

	const separator = value.indexOf(":")
	if (separator > 0) {
		const id = value.slice(0, separator).trim()
		const secret = value.slice(separator + 1).trim()
		if (id !== "" && secret !== "") return { id, secret }
	}

	// A bare secret in the id field is a misfire, not an id — route it.
	if (field === "id" && value.startsWith(SECRET_PREFIX)) {
		return { id: current.id, secret: value }
	}
	return field === "id" ? { id: value, secret: current.secret } : { id: current.id, secret: value }
}

/**
 * The one manual step in the PlanetScale setup: a service token scoped to
 * `read_metrics_endpoints`.
 *
 * The API's rejection message (token invalid, permission missing) is the most
 * actionable text in the whole flow, so it renders inline and *stays* — it used
 * to go to a toast and vanish before anyone could act on it.
 */
export function PlanetScaleMetricsTokenForm({
	organization,
	docsUrl,
	mode,
	onSaved,
	onCancel,
}: {
	organization: string | null
	/** Fallback destination when the org slug isn't known yet. */
	docsUrl?: string
	mode: "initial" | "rotate"
	onSaved: () => void
	onCancel?: () => void
}) {
	const setMetricsToken = useAtomSet(
		MapleApiV2AtomClient.mutation("planetscaleIntegration", "setMetricsToken"),
		{ mode: "promiseExit" },
	)
	const [fields, setFields] = useState<TokenFields>({ id: "", secret: "" })
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const secretLooksWrong = fields.secret.length > 0 && !fields.secret.startsWith(SECRET_PREFIX)
	const canSubmit = fields.id.trim().length > 0 && fields.secret.length > 0 && !submitting

	async function handleSubmit() {
		setSubmitting(true)
		setError(null)
		const result = await setMetricsToken({
			payload: {
				token_id: fields.id.trim(),
				token_secret: fields.secret,
			},
			// The managed scrape target flips authType/enabled — refresh that list too.
			reactivityKeys: ["planetscaleIntegration", "scrapeTargets"],
		})
		setSubmitting(false)
		if (Exit.isSuccess(result)) {
			toastManager.add({ title: "Branch metrics enabled", type: "success" })
			setFields({ id: "", secret: "" })
			onSaved()
			return
		}
		setError(extractErrorMessage(result) ?? "Failed to save the metrics service token.")
	}

	const linkHref = organization !== null ? tokenSettingsUrl(organization) : (docsUrl ?? null)

	return (
		<div className="flex flex-col gap-3">
			<p className="text-xs text-muted-foreground">
				Create a service token with the single{" "}
				<code className="font-mono text-[11px]">read_metrics_endpoints</code> permission — no other
				permission is needed, and Maple never uses it for anything else.
			</p>

			{linkHref !== null ? (
				<div>
					<Button
						size="sm"
						variant="outline"
						render={
							<a href={linkHref} target="_blank" rel="noreferrer">
								{organization !== null
									? "Create a token in PlanetScale"
									: "How to create a token"}
								<ExternalLinkIcon size={14} />
							</a>
						}
					/>
				</div>
			) : null}

			<div className="flex flex-wrap items-end gap-2">
				<div className="flex min-w-40 flex-1 flex-col gap-1.5">
					<Label htmlFor="ps-metrics-token-id">Service token ID</Label>
					<Input
						id="ps-metrics-token-id"
						placeholder="tok_…"
						value={fields.id}
						autoComplete="off"
						onChange={(event) => setFields((prev) => ({ ...prev, id: event.target.value }))}
						onPaste={(event) => {
							event.preventDefault()
							setFields(normalizeTokenPaste("id", event.clipboardData.getData("text"), fields))
						}}
					/>
				</div>
				<div className="flex min-w-40 flex-1 flex-col gap-1.5">
					<Label htmlFor="ps-metrics-token-secret">Service token secret</Label>
					<Input
						id="ps-metrics-token-secret"
						type="password"
						placeholder={`${SECRET_PREFIX}…`}
						value={fields.secret}
						autoComplete="off"
						onChange={(event) => setFields((prev) => ({ ...prev, secret: event.target.value }))}
						onPaste={(event) => {
							event.preventDefault()
							setFields(
								normalizeTokenPaste("secret", event.clipboardData.getData("text"), fields),
							)
						}}
					/>
				</div>
				<div className="flex items-center gap-1.5">
					{onCancel !== undefined ? (
						<Button variant="outline" onClick={onCancel} disabled={submitting}>
							Cancel
						</Button>
					) : null}
					<Button onClick={handleSubmit} disabled={!canSubmit}>
						{submitting ? <LoaderIcon size={14} className="animate-spin" /> : null}
						{mode === "rotate" ? "Update token" : "Enable metrics"}
					</Button>
				</div>
			</div>

			{/* Advisory only — the prefix is PlanetScale's convention, not a contract
			    we should enforce on the operator's behalf. */}
			{secretLooksWrong && error === null ? (
				<p className="text-xs text-muted-foreground">
					That doesn&apos;t look like a service token secret — it usually starts with{" "}
					<code className="font-mono text-[11px]">{SECRET_PREFIX}</code>.
				</p>
			) : null}

			{error !== null ? (
				<p className="text-xs text-severity-error" role="alert">
					{error}
				</p>
			) : null}
		</div>
	)
}

/** Best-effort human message from a failed mutation Exit (tagged API errors carry one). */
function extractErrorMessage(result: Exit.Exit<unknown, unknown>): string | null {
	if (Exit.isSuccess(result)) return null
	const first = Cause.prettyErrors(result.cause)[0]
	return first?.message ?? null
}
