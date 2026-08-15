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
import { useMemo, useRef, useState, type ReactNode } from "react"
import { Exit, Schema } from "effect"
import { DashboardId } from "@maple/domain/http"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import {
	CheckIcon,
	CircleWarningIcon,
	CopyIcon,
	GlobeIcon,
	LinkIcon,
	LockIcon,
	ShieldIcon,
} from "@/components/icons"
import { Button } from "@maple/ui/components/ui/button"
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { RadioGroup, RadioGroupItem } from "@maple/ui/components/ui/radio-group"
import { cn } from "@maple/ui/lib/utils"
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
	readonly token: string
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

	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	/*
	 * The picked mode is held locally until the server confirms it, because the
	 * round-trip is long enough to see: the dot used to move ~100ms after the
	 * click, which reads as the dialog stuttering rather than responding. Server
	 * state stays the source of truth — this only covers the gap, and a failed
	 * mutation drops it so the radio falls back to what is actually stored.
	 */
	const serverMode: ShareMode | "off" = boardShare?.mode ?? "off"
	const [pendingMode, setPendingMode] = useState<ShareMode | "off" | null>(null)
	if (pendingMode !== null && pendingMode === serverMode) setPendingMode(null)

	const unsupported = useMemo(() => unsupportedShareWidgets(dashboard.widgets), [dashboard.widgets])

	/*
	 * Nothing in the dialog uses `disabled` to keep mutations from stacking —
	 * disabling a control mid-flight dims it for the length of the round-trip, and
	 * every pick or regenerate flashed. The guard lives here instead, so the
	 * protection is centralised and no control has to change how it looks to get it.
	 */
	const run = async <A,>(action: () => Promise<Exit.Exit<A, unknown>>) => {
		if (busy) return null
		setBusy(true)
		setError(null)
		try {
			const result = await action()
			if (Exit.isFailure(result)) {
				setError(displayError(result).message)
				setPendingMode(null)
				return null
			}
			refreshList()
			return result.value
		} finally {
			setBusy(false)
		}
	}

	/*
	 * None of these keep the token: the refreshed list carries it, because storage
	 * holds an encrypted copy the server can read back. There is no shown-once
	 * value left to stash, and nothing here can lose one.
	 */
	const share = (mode: ShareMode) =>
		run(() =>
			upsert({
				params: { id: asDashboardId(dashboard.id) },
				payload: { mode },
				reactivityKeys: [`dashboard-shares:${dashboard.id}`],
			}),
		)

	const regenerate = () =>
		run(() =>
			rotate({
				params: { id: asDashboardId(dashboard.id) },
				reactivityKeys: [`dashboard-shares:${dashboard.id}`],
			}),
		)

	const stopSharing = () =>
		run(() =>
			revoke({
				params: { id: asDashboardId(dashboard.id) },
				reactivityKeys: [`dashboard-shares:${dashboard.id}`],
			}),
		)

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Share dashboard</DialogTitle>
					<DialogDescription>
						Anyone you share with sees this dashboard's data, but cannot edit it.
					</DialogDescription>
				</DialogHeader>

				<DialogPanel className="space-y-4">
					{/* One bordered, divided group rather than three floating cards: this is a
					    single choice, and the icons read left-to-right as a ladder of exposure. */}
					<RadioGroup
						value={pendingMode ?? serverMode}
						onValueChange={(value) => {
							// Checked before the optimistic move, so a pick `run` will refuse
							// never lands on screen.
							if (busy) return
							setPendingMode(value as ShareMode | "off")
							if (value === "off") void stopSharing()
							else void share(value as ShareMode)
						}}
						className="gap-0 divide-y divide-border overflow-hidden rounded-lg border"
					>
						<ShareOption
							value="off"
							icon={LockIcon}
							title="Not shared"
							body="Only members of this organization with access to Maple can see it."
						/>
						<ShareOption
							value="org"
							icon={ShieldIcon}
							title="Anyone in this organization"
							body="Signed-in members of this organization can open the link."
						/>
						<ShareOption
							value="public"
							icon={GlobeIcon}
							title="Anyone with the link"
							body="No sign-in required. Anyone who has the link can view this dashboard and its data."
						/>
					</RadioGroup>

					{boardShare ? (
						<ShareLinkRow token={boardShare.token} onRegenerate={() => void regenerate()} />
					) : null}

					{unsupported.length > 0 && boardShare ? (
						<NoticeRow>
							{unsupported.length === 1
								? "1 widget won't render for viewers"
								: `${unsupported.length} widgets won't render for viewers`}
							: {unsupported.map((widget) => widget.title).join(", ")}. Shared views support{" "}
							{SHAREABLE_WIDGET_KINDS}.
						</NoticeRow>
					) : null}

					{error ? <NoticeRow tone="error">{error}</NoticeRow> : null}
				</DialogPanel>

				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>Done</DialogClose>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

/**
 * The whole row is the hit target. The radio nests *inside* the `<label>` rather
 * than pairing with `htmlFor`: Base UI renders it as a `<button>`, and label-for-
 * button forwarding is inconsistent across browsers where implicit association is
 * not. Selection is styled off `:has([data-checked])` because Base UI puts the
 * state on the radio, not on any wrapper we own.
 */
function ShareOption({
	value,
	icon: Icon,
	title,
	body,
}: {
	value: string
	icon: typeof LockIcon
	title: string
	body: string
}) {
	return (
		<label
			htmlFor={`share-${value}`}
			className="group flex cursor-pointer items-start gap-3 px-3.5 py-3 transition-colors hover:bg-accent/40 has-[[data-checked]]:bg-accent/64"
		>
			<Icon
				size={15}
				className="mt-0.5 shrink-0 text-muted-foreground transition-colors group-has-[[data-checked]]:text-primary"
			/>
			<div className="min-w-0 flex-1 space-y-0.5">
				<div className="font-medium text-sm leading-5">{title}</div>
				<p className="text-muted-foreground text-xs leading-relaxed">{body}</p>
			</div>
			<RadioGroupItem value={value} id={`share-${value}`} className="mt-0.5 shrink-0" />
		</label>
	)
}

function NoticeRow({ tone = "muted", children }: { tone?: "muted" | "error"; children: ReactNode }) {
	return (
		<div
			className={cn(
				"flex items-start gap-2 text-xs leading-relaxed",
				tone === "error" ? "text-destructive-foreground" : "text-muted-foreground",
			)}
		>
			<CircleWarningIcon size={13} className="mt-0.5 shrink-0" />
			<p className="min-w-0">{children}</p>
		</div>
	)
}

function ShareLinkRow({ token, onRegenerate }: { token: string; onRegenerate: () => void }) {
	const [copied, setCopied] = useState(false)
	const [copyBlocked, setCopyBlocked] = useState(false)
	const resetCopied = useRef<ReturnType<typeof setTimeout>>(undefined)
	const field = useRef<HTMLInputElement>(null)
	const url = `${window.location.origin}/share/${token}`

	// Browsers deny `writeText` outside a secure context or when the clipboard
	// permission is refused, and the promise rejects. Without this the button just
	// sat there — the one thing the dialog exists to hand over, silently withheld.
	// Falling back to selecting the field leaves ⌘C as a working escape.
	const copy = () => {
		void navigator.clipboard.writeText(url).then(
			() => {
				setCopyBlocked(false)
				setCopied(true)
				clearTimeout(resetCopied.current)
				resetCopied.current = setTimeout(() => setCopied(false), 2000)
			},
			() => {
				setCopyBlocked(true)
				field.current?.select()
			},
		)
	}

	return (
		<div className="space-y-2">
			<div className="flex items-center gap-2">
				<div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-input bg-muted/40 px-2.5 font-mono text-xs focus-within:border-ring sm:h-7">
					<LinkIcon size={13} className="shrink-0 text-muted-foreground" />
					{/* A real input rather than a span: the link stays selectable, which is
					    what makes the clipboard fallback above worth anything. */}
					<input
						ref={field}
						readOnly
						aria-label="Share link"
						value={url}
						onFocus={(event) => event.currentTarget.select()}
						className="min-w-0 flex-1 truncate bg-transparent outline-none"
					/>
				</div>
				<Button size="sm" onClick={copy}>
					{copied ? <CheckIcon /> : <CopyIcon />}
					{copied ? "Copied" : "Copy"}
				</Button>
			</div>
			<Button variant="ghost" size="xs" className="-ml-2 text-muted-foreground" onClick={onRegenerate}>
				Regenerate link
			</Button>
			{copyBlocked ? (
				<p className="text-muted-foreground text-xs leading-relaxed">
					Your browser blocked the clipboard. The link is selected — copy it with ⌘C.
				</p>
			) : null}
			<span aria-live="polite" className="sr-only">
				{copied ? "Share link copied to clipboard" : ""}
			</span>
		</div>
	)
}
