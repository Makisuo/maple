/**
 * Share a dashboard, or one chart on it.
 *
 * Two independent things live here, and the dialog keeps them visibly separate
 * because their consequences differ: a board link is for people, a chart link
 * is usually for an embed in a page the org does not control.
 *
 * Mutations go through `MapleApiV2AtomClient` rather than the TanStack DB
 * optimistic path used elsewhere in the builder. The shares table is not
 * Electric-synced — deliberately, so share metadata is not pushed into every
 * org member's shape stream — so there is no txid to await and `awaitTxId`
 * would hang forever.
 */
import { useMemo, useState } from "react"
import { Exit, Schema } from "effect"
import { DashboardId } from "@maple/domain/http"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { CheckIcon, CopyIcon, LinkIcon } from "@/components/icons"
import { Button } from "@maple/ui/components/ui/button"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { RadioGroup, RadioGroupItem } from "@maple/ui/components/ui/radio-group"
import { Label } from "@maple/ui/components/ui/label"
import { MapleApiV2AtomClient, retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { displayError } from "@/lib/error-messages"
import { SHAREABLE_WIDGET_KINDS, unsupportedShareWidgets } from "./share-support"
import type { Dashboard } from "@/components/dashboard-builder/types"

type ShareMode = "public" | "org"

/**
 * The v2 atom client hands back the *decoded* record, so these are the camelCase
 * domain names — not the snake_case the wire carries.
 */
interface ShareRecord {
	readonly id: string
	readonly widgetId?: string
	readonly mode: ShareMode
	readonly tokenSuffix: string
}

const asDashboardId = Schema.decodeUnknownSync(DashboardId)

export function ShareDashboardDialog({
	dashboard,
	open,
	onOpenChange,
}: {
	dashboard: Dashboard
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	const listAtom = useMemo(
		() =>
			retainedQueryV2("dashboards", "listShares", {
				params: { id: asDashboardId(dashboard.id) },
				reactivityKeys: [`dashboard-shares:${dashboard.id}`],
			}),
		[dashboard.id],
	)
	const listResult = useAtomValue(listAtom)
	const refreshList = useAtomRefresh(listAtom)

	const upsert = useAtomSet(MapleApiV2AtomClient.mutation("dashboards", "upsertShare"), {
		mode: "promiseExit",
	})
	const rotate = useAtomSet(MapleApiV2AtomClient.mutation("dashboards", "rotateShare"), {
		mode: "promiseExit",
	})
	const revoke = useAtomSet(MapleApiV2AtomClient.mutation("dashboards", "revokeShare"), {
		mode: "promiseExit",
	})

	const shares = useMemo<ReadonlyArray<ShareRecord>>(
		() => (Result.isSuccess(listResult) ? (listResult.value as ReadonlyArray<ShareRecord>) : []),
		[listResult],
	)
	const boardShare = useMemo(() => shares.find((share) => share.widgetId === undefined), [shares])

	// The raw token only ever exists in the response that minted it, so it is
	// held here rather than re-read: nothing can fetch it back.
	const [mintedToken, setMintedToken] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const unsupported = useMemo(() => unsupportedShareWidgets(dashboard.widgets), [dashboard.widgets])

	const run = async <A,>(action: () => Promise<Exit.Exit<A, unknown>>) => {
		setBusy(true)
		setError(null)
		try {
			const result = await action()
			if (Exit.isFailure(result)) {
				setError(displayError(result).message)
				return null
			}
			refreshList()
			return result.value
		} finally {
			setBusy(false)
		}
	}

	const share = (mode: ShareMode) =>
		run(() =>
			upsert({
				params: { id: asDashboardId(dashboard.id) },
				payload: { mode },
				reactivityKeys: [`dashboard-shares:${dashboard.id}`],
			}),
		).then((value) => {
			// Absent on a mode change, which keeps the existing link — showing the
			// copy affordance then would imply a new URL that does not exist.
			if (value?.token) setMintedToken(value.token)
		})

	const regenerate = () =>
		run(() =>
			rotate({
				params: { id: asDashboardId(dashboard.id) },
				reactivityKeys: [`dashboard-shares:${dashboard.id}`],
			}),
		).then((value) => {
			if (value?.token) setMintedToken(value.token)
		})

	const stopSharing = () =>
		run(() =>
			revoke({
				params: { id: asDashboardId(dashboard.id) },
				reactivityKeys: [`dashboard-shares:${dashboard.id}`],
			}),
		).then(() => setMintedToken(null))

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Share dashboard</DialogTitle>
					<DialogDescription>
						Anyone you share with sees this dashboard's data, but cannot edit it.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<RadioGroup
						value={boardShare?.mode ?? "off"}
						onValueChange={(value) => {
							if (value === "off") void stopSharing()
							else void share(value as ShareMode)
						}}
						className="space-y-2"
					>
						<ShareOption
							value="off"
							title="Not shared"
							body="Only members of this organization with access to Maple can see it."
						/>
						<ShareOption
							value="org"
							title="Anyone in this organization"
							body="Signed-in members of this organization can open the link."
						/>
						<ShareOption
							value="public"
							title="Anyone with the link"
							body="No sign-in required. Anyone who has the link can view this dashboard and its data."
						/>
					</RadioGroup>

					{boardShare ? (
						<ShareLinkRow
							token={mintedToken}
							suffix={boardShare.tokenSuffix}
							busy={busy}
							onRegenerate={() => void regenerate()}
						/>
					) : null}

					{unsupported.length > 0 && boardShare ? (
						<p className="rounded-md bg-muted/50 p-3 text-muted-foreground text-xs">
							{unsupported.length === 1
								? "1 widget won't render for viewers"
								: `${unsupported.length} widgets won't render for viewers`}
							: {unsupported.map((widget) => widget.title).join(", ")}. Shared views support{" "}
							{SHAREABLE_WIDGET_KINDS}.
						</p>
					) : null}

					{error ? <p className="text-destructive text-xs">{error}</p> : null}
				</div>

				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Done
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

function ShareOption({ value, title, body }: { value: string; title: string; body: string }) {
	return (
		<div className="flex items-start gap-3 rounded-md border p-3">
			<RadioGroupItem value={value} id={`share-${value}`} className="mt-1" />
			<div className="space-y-0.5">
				<Label htmlFor={`share-${value}`} className="font-medium text-sm">
					{title}
				</Label>
				<p className="text-muted-foreground text-xs">{body}</p>
			</div>
		</div>
	)
}

function ShareLinkRow({
	token,
	suffix,
	busy,
	onRegenerate,
}: {
	token: string | null
	suffix: string
	busy: boolean
	onRegenerate: () => void
}) {
	const [copied, setCopied] = useState(false)
	const url = token === null ? null : `${window.location.origin}/share/${token}`

	const copy = () => {
		if (url === null) return
		void navigator.clipboard.writeText(url).then(() => {
			setCopied(true)
			setTimeout(() => setCopied(false), 2000)
		})
	}

	return (
		<div className="space-y-2">
			<div className="flex items-center gap-2">
				<div className="flex flex-1 items-center gap-2 truncate rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs">
					<LinkIcon size={14} className="shrink-0 text-muted-foreground" />
					{/* The link is only displayable in the session that minted it — the
					    token is stored hashed, so a reopened dialog can identify the link
					    by its suffix but can never show it again. */}
					<span className="truncate">{url ?? `Link ending in …${suffix}`}</span>
				</div>
				{url === null ? null : (
					<Button variant="outline" size="sm" onClick={copy} disabled={busy}>
						{copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
						{copied ? "Copied" : "Copy"}
					</Button>
				)}
			</div>
			<div className="flex items-center gap-3">
				<Button variant="ghost" size="sm" onClick={onRegenerate} disabled={busy}>
					Regenerate link
				</Button>
				{url === null ? (
					<span className="text-muted-foreground text-xs">
						Regenerate to get a copyable link. The current one keeps working until you do.
					</span>
				) : null}
			</div>
		</div>
	)
}
