import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"

import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { Atom, Result, useAtomValue } from "@/lib/effect-atom"
import { CheckIcon, CopyIcon } from "@/components/icons"
import type { VcsCommitDetailResponse } from "@maple/domain/http"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@maple/ui/components/ui/hover-card"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { useClipboard } from "@maple/ui/hooks/use-clipboard"
import { cn } from "@maple/ui/utils"

// A full 40-hex git SHA. Telemetry `deployment.commit_sha` is unguarded OTel
// data, so a value may be a short SHA, a tag, or arbitrary text — those never
// open a hover card (and never hit the backend); they render as plain children.
const FULL_SHA = /^[0-9a-f]{40}$/i

/** Whether `sha` is a full 40-hex git SHA that the VCS endpoint can resolve. */
export function isResolvableSha(sha: string): boolean {
	return FULL_SHA.test(sha)
}

// Card becomes visible after this long a hover; fetch is armed sooner (ARM_DELAY_MS)
// so the request is already in flight (or cached) when the card opens.
const OPEN_DELAY_MS = 200
const ARM_DELAY_MS = 20

interface CommitShaHoverCardProps {
	/** The full commit SHA. If not a 40-hex SHA, children render without a card. */
	sha: string
	/** The trigger content (typically the truncated, styled SHA). */
	children: ReactNode
	/** Applied to the trigger element. */
	className?: string
	/**
	 * When set, the trigger is a button that copies this value on click (with a
	 * toast). Keeps copy affordance and hover card in one element so they never
	 * stack as separate popups.
	 */
	copy?: { value: string; label: string }
	/**
	 * How long (ms) the trigger must be hovered before the card opens. Defaults to
	 * a snappy 200ms. Deploy markers pass a much longer delay (~1.5s): their hitbox
	 * spans the whole reference line, so a cursor merely crossing the chart
	 * shouldn't trip the card open.
	 */
	openDelay?: number
	/** Side the popup opens on, relative to its anchor (default "bottom"). */
	side?: "top" | "right" | "bottom" | "left"
	/** Cross-axis alignment of the popup (default "start"). */
	align?: "start" | "center" | "end"
	/** Popup distance from its anchor in px (default 6). */
	sideOffset?: number
	/**
	 * Anchor the popup to a specific element rather than the trigger. Deploy markers
	 * use this to pin the card to the flag at the top of the line while the hover
	 * hitbox spans the line's full height.
	 */
	anchor?: RefObject<HTMLElement | null>
}

/**
 * Wraps a rendered commit SHA in a rich hover card that lazily resolves the
 * commit's details from the (vendor-agnostic) VCS endpoint. Decoupled timing:
 * the fetch is armed after ~20ms of hover, while the card itself only becomes
 * visible after ~200ms — so the card almost always opens onto loaded data.
 */
export function CommitShaHoverCard({
	sha,
	children,
	className,
	copy,
	openDelay = OPEN_DELAY_MS,
	side = "bottom",
	align = "start",
	sideOffset = 6,
	anchor,
}: CommitShaHoverCardProps) {
	const isFullSha = FULL_SHA.test(sha)
	const clipboard = useClipboard()
	// Once armed we keep it armed: the in-flight/cached result should survive the
	// cursor leaving, so a re-hover is instant.
	const [armed, setArmed] = useState(false)
	const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

	useEffect(
		() => () => {
			if (armTimer.current) clearTimeout(armTimer.current)
		},
		[],
	)

	const handleCopy = copy
		? async () => {
				try {
					await clipboard.copy(copy.value)
					toast.success(`${copy.label} copied to clipboard`)
				} catch {
					toast.error(`Failed to copy ${copy.label}`)
				}
			}
		: undefined

	// Non-resolvable SHA (short/tag/arbitrary telemetry): no card, no fetch. Still
	// copyable where a copy affordance was requested.
	if (!isFullSha) {
		return handleCopy ? (
			<button type="button" onClick={handleCopy} className={cn("cursor-pointer", className)}>
				{children}
			</button>
		) : (
			<span className={className}>{children}</span>
		)
	}

	const arm = () => {
		if (armed || armTimer.current) return
		armTimer.current = setTimeout(() => {
			armTimer.current = null
			setArmed(true)
		}, ARM_DELAY_MS)
	}

	const cancelArm = () => {
		if (armTimer.current) {
			clearTimeout(armTimer.current)
			armTimer.current = null
		}
	}

	return (
		<HoverCard>
			{/* The popup content (and its query) only mounts when the card opens at
			    ~200ms; this sibling mounts as soon as armed (~20ms) and subscribes to
			    the SAME memoized atom, so the fetch is already in flight by open. */}
			{armed ? <CommitPrefetch sha={sha} /> : null}
			<HoverCardTrigger
				render={handleCopy ? <button type="button" onClick={handleCopy} /> : <span />}
				delay={openDelay}
				className={cn(handleCopy ? "cursor-pointer" : "cursor-default", className)}
				onMouseEnter={arm}
				onMouseLeave={cancelArm}
				onFocus={arm}
			>
				{children}
			</HoverCardTrigger>
			<HoverCardContent
				side={side}
				align={align}
				sideOffset={sideOffset}
				anchor={anchor}
				className="w-80 p-0"
			>
				<CommitDetailBody sha={sha} />
			</HoverCardContent>
		</HoverCard>
	)
}

const COMMIT_DETAIL_TTL_MS = 5 * 60_000

// Per-SHA query atom. Wrapping `MapleApiAtomClient.query` in `Atom.family` keyed by
// the SHA *string* is what actually lets the prefetch subscriber, the popup body,
// the deploy-marker flags, and the commit-list rows share ONE fetch + cached result.
export const commitQueryAtom = Atom.family((sha: string) =>
	MapleApiAtomClient.query("integrations", "vcsCommitDetail", {
		params: { sha },
		timeToLive: COMMIT_DETAIL_TTL_MS,
	}),
)

// Renders nothing — it exists only to mount (and thus run) the query early.
function CommitPrefetch({ sha }: { sha: string }) {
	useAtomValue(commitQueryAtom(sha))
	return null
}

/**
 * Resolves a commit SHA and renders its detail card — the shared body used by
 * the hover card and the chart's deploy-marker tooltip. `compact` tightens the
 * layout for dense stacks (several commits in one tooltip). Non-resolvable
 * references (short SHAs, tags, arbitrary telemetry) render as plain text and
 * never hit the backend.
 */
export function CommitDetailBody({ sha, compact = false }: { sha: string; compact?: boolean }) {
	if (!isResolvableSha(sha)) {
		return <CommitPlain sha={sha} compact={compact} />
	}
	return <CommitHoverBody sha={sha} compact={compact} />
}

function CommitHoverBody({ sha, compact = false }: { sha: string; compact?: boolean }) {
	// By the time the popup opens (open delay > arm delay) the prefetch has already
	// armed the same atom; reading it here is a cache hit or a near-complete fetch.
	const result = useAtomValue(commitQueryAtom(sha))

	return Result.builder(result)
		.onSuccess((commit) => <CommitCard commit={commit} compact={compact} />)
		.onError((error) => <CommitMessage {...describeError(error)} compact={compact} />)
		.orElse(() => <CommitSkeleton compact={compact} />)
}

// A reference Maple can't resolve to a commit (short SHA, tag, arbitrary
// `deployment.commit_sha` telemetry). Shown in the marker tooltip — which, unlike
// the hover card, always renders a row for every commit in a bucket.
function CommitPlain({ sha, compact = false }: { sha: string; compact?: boolean }) {
	return (
		<div className={cn("flex flex-col gap-1", compact ? "p-2.5" : "p-3.5")}>
			<span className="font-mono text-foreground">
				{sha.length > 16 ? `${sha.slice(0, 16)}…` : sha}
			</span>
			<span className="text-muted-foreground">Deployment reference — not a resolvable git commit.</span>
		</div>
	)
}

function CommitCard({ commit, compact = false }: { commit: VcsCommitDetailResponse; compact?: boolean }) {
	// A git message is a subject line, then an optional body after a blank line.
	const newlineIdx = commit.message.indexOf("\n")
	const title = newlineIdx === -1 ? commit.message : commit.message.slice(0, newlineIdx)
	const body = newlineIdx === -1 ? "" : commit.message.slice(newlineIdx + 1).trim()
	const providerLabel = commit.provider === "github" ? "GitHub" : commit.provider
	const author = commit.authorLogin ?? commit.authorName ?? "Unknown author"
	// Profile and repo links are derived from the commit's own htmlUrl origin, so
	// they stay correct across providers and self-hosted instances (github.com, GH
	// Enterprise, GitLab, …) without hardcoding a host.
	const profileHref = commit.authorLogin ? hrefFromOrigin(commit.htmlUrl, commit.authorLogin) : null
	const repoHref = commit.repoFullName ? hrefFromOrigin(commit.htmlUrl, commit.repoFullName) : null

	const pad = compact ? "p-2.5" : "p-3.5"
	return (
		<div className="flex flex-col divide-y divide-foreground/10">
			<div className={cn("flex flex-col gap-1.5", pad)}>
				<p
					className={cn(
						"font-medium leading-snug text-foreground",
						compact ? "line-clamp-2 text-[13px]" : "line-clamp-2 text-sm",
					)}
				>
					{title}
				</p>
				{body && !compact ? (
					<p className="line-clamp-4 whitespace-pre-line text-muted-foreground">{body}</p>
				) : null}
			</div>
			<div className={cn("flex flex-col", compact ? "gap-2" : "gap-2.5", pad)}>
				<div className="flex items-center gap-2.5">
					<CommitAvatar url={commit.authorAvatarUrl} name={author} href={profileHref} compact={compact} />
					<div className="flex min-w-0 flex-col leading-tight">
						<ExternalText href={profileHref} className="truncate font-medium text-foreground">
							{author}
						</ExternalText>
						{commit.repoFullName ? (
							<ExternalText href={repoHref} className="truncate text-muted-foreground">
								{commit.repoFullName}
							</ExternalText>
						) : null}
					</div>
				</div>
				<div className="flex items-center justify-between gap-2 text-muted-foreground">
					<CopyableSha sha={commit.sha} />
					<span title={formatExact(commit.committedAt)} className="cursor-default">
						{formatRelative(commit.committedAt)}
					</span>
				</div>
			</div>
			<a
				href={commit.htmlUrl}
				target="_blank"
				rel="noreferrer noopener"
				className={cn(
					"flex items-center justify-center gap-1 font-medium text-primary transition-colors hover:bg-muted/60",
					compact ? "px-2.5 py-2" : "px-3.5 py-2.5",
				)}
			>
				View on {providerLabel}
				<span aria-hidden>↗</span>
			</a>
		</div>
	)
}

// A git message is a subject line, then an optional body after a blank line.
export function firstLine(message: string): string {
	const idx = message.indexOf("\n")
	return (idx === -1 ? message : message.slice(0, idx)).trim()
}

/**
 * A vertically-dense list of commits for a deploy marker that gathers several of
 * them. Each commit is ONE row (avatar · subject · short sha · age) instead of a
 * stack of full `CommitCard`s — so a marker with a dozen commits stays a tidy,
 * scrollable list rather than a wall of cards. The single-commit case keeps the
 * rich `CommitDetailBody`; this is only used when there's more than one.
 */
export function CommitListBody({ commits }: { commits: ReadonlyArray<{ sha: string }> }) {
	return (
		<div className="flex flex-col">
			{/* Sticky so the count stays visible while the rows scroll. */}
			<div className="sticky top-0 z-10 flex items-center justify-between border-b border-foreground/10 bg-popover/95 px-2.5 py-1.5 backdrop-blur-sm">
				<span className="font-medium text-foreground">{commits.length} deploys</span>
			</div>
			<div className="flex flex-col divide-y divide-foreground/5">
				{commits.map((commit) => (
					<CommitListRow key={commit.sha} sha={commit.sha} />
				))}
			</div>
		</div>
	)
}

// One commit row. Non-resolvable references (short sha, tag, arbitrary telemetry)
// never hit the backend — they render as a muted, label-only row.
function CommitListRow({ sha }: { sha: string }) {
	if (!isResolvableSha(sha)) {
		return (
			<div className="flex items-center gap-2.5 px-2.5 py-2 text-muted-foreground">
				<span className="size-5 shrink-0 rounded-full bg-muted" />
				<div className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
					<span className="truncate font-mono text-[11px]">
						{sha.length > 18 ? `${sha.slice(0, 18)}…` : sha}
					</span>
					<span className="text-[10px]">Deployment reference</span>
				</div>
			</div>
		)
	}
	return <CommitListRowResolved sha={sha} />
}

function CommitListRowResolved({ sha }: { sha: string }) {
	const result = useAtomValue(commitQueryAtom(sha))
	return Result.builder(result)
		.onSuccess((commit) => <CommitListRowLink commit={commit} />)
		.onError(() => <CommitListRowFallback sha={sha} note="unavailable" />)
		.orElse(() => <CommitListRowSkeleton />)
}

// Only the avatar and the subject are interactive: the avatar → the author's
// profile, the subject → the commit. The row itself has no hover affordance, so
// the second line (author · sha · age) stays plain text.
function CommitListRowLink({ commit }: { commit: VcsCommitDetailResponse }) {
	const title = firstLine(commit.message)
	const author = commit.authorLogin ?? commit.authorName ?? "Unknown author"
	const profileHref = commit.authorLogin ? hrefFromOrigin(commit.htmlUrl, commit.authorLogin) : null
	return (
		<div className="flex items-center gap-2.5 px-2.5 py-2">
			<CommitAvatar url={commit.authorAvatarUrl} name={author} href={profileHref} compact />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
				<a
					href={commit.htmlUrl}
					target="_blank"
					rel="noreferrer noopener"
					title={title}
					className="truncate text-foreground transition-colors hover:text-primary hover:underline"
				>
					{title}
				</a>
				<span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
					<span className="min-w-0 truncate">{author}</span>
					<span className="shrink-0 font-mono">{commit.sha.slice(0, 7)}</span>
					<span
						title={formatExact(commit.committedAt)}
						className="ml-auto shrink-0 tabular-nums text-muted-foreground/80"
					>
						{formatRelative(commit.committedAt, { short: true })}
					</span>
				</span>
			</div>
		</div>
	)
}

function CommitListRowSkeleton() {
	return (
		<div className="flex items-center gap-2.5 px-2.5 py-2">
			<Skeleton className="size-5 shrink-0 rounded-full" />
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<Skeleton className="h-3 w-3/4" />
				<Skeleton className="h-2.5 w-1/2" />
			</div>
		</div>
	)
}

function CommitListRowFallback({ sha, note }: { sha: string; note: string }) {
	return (
		<div className="flex items-center gap-2.5 px-2.5 py-2 text-muted-foreground">
			<span className="size-5 shrink-0 rounded-full bg-muted" />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
				<span className="truncate font-mono text-[11px]">{sha.slice(0, 12)}</span>
				<span className="text-[10px]">{note}</span>
			</div>
		</div>
	)
}

// Builds an absolute URL from the origin of a known-good commit URL plus a path
// (an author login, or `owner/repo`). Origin-relative so the path's own slashes
// are preserved. Returns null if the base URL can't be parsed.
function hrefFromOrigin(baseUrl: string, path: string): string | null {
	try {
		return new URL(`/${path}`, baseUrl).href
	} catch {
		return null
	}
}

// Text that links out (new tab) when an href is available, else plain text. Used
// for the author and repo lines so both become clickable when resolvable.
function ExternalText({
	href,
	className,
	children,
}: {
	href: string | null
	className?: string
	children: ReactNode
}) {
	if (!href) {
		return <span className={className}>{children}</span>
	}
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer noopener"
			className={cn("transition-colors hover:text-foreground hover:underline", className)}
		>
			{children}
		</a>
	)
}

// The short SHA, rendered as a copy button (copies the full SHA). Replaces the
// bare badge so the value is actually useful instead of just decorative.
function CopyableSha({ sha }: { sha: string }) {
	const clipboard = useClipboard()
	const [copied, setCopied] = useState(false)
	const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

	useEffect(
		() => () => {
			if (resetTimer.current) clearTimeout(resetTimer.current)
		},
		[],
	)

	const handleCopy = async () => {
		try {
			await clipboard.copy(sha)
			setCopied(true)
			if (resetTimer.current) clearTimeout(resetTimer.current)
			resetTimer.current = setTimeout(() => setCopied(false), 1200)
		} catch {
			toast.error("Failed to copy commit SHA")
		}
	}

	return (
		<button
			type="button"
			onClick={handleCopy}
			aria-label="Copy commit SHA"
			className="group inline-flex items-center gap-1.5 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80 transition-colors hover:bg-muted/70"
		>
			{sha.slice(0, 7)}
			{copied ? (
				<CheckIcon size={11} className="text-success" />
			) : (
				<CopyIcon
					size={11}
					className="text-muted-foreground transition-colors group-hover:text-foreground/80"
				/>
			)}
		</button>
	)
}

function CommitAvatar({
	url,
	name,
	href,
	compact = false,
}: {
	url: string | null
	name: string
	href?: string | null
	compact?: boolean
}) {
	const [failed, setFailed] = useState(false)
	const size = compact ? "size-5" : "size-7"
	const inner =
		url && !failed ? (
			<img
				src={url}
				alt=""
				className={cn(size, "shrink-0 rounded-full ring-1 ring-foreground/10")}
				loading="lazy"
				referrerPolicy="no-referrer"
				onError={() => setFailed(true)}
			/>
		) : (
			<div
				className={cn(
					size,
					"flex shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium uppercase text-muted-foreground",
				)}
			>
				{name.slice(0, 2)}
			</div>
		)

	if (!href) return inner
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer noopener"
			aria-label={`${name}'s profile`}
			className="shrink-0 rounded-full outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-foreground/30"
		>
			{inner}
		</a>
	)
}

function CommitSkeleton({ compact = false }: { compact?: boolean }) {
	return (
		<div className={cn("flex flex-col", compact ? "gap-2 p-2.5" : "gap-3 p-3.5")}>
			<Skeleton className="h-4 w-11/12" />
			<div className="flex items-center gap-2.5">
				<Skeleton className={cn("shrink-0 rounded-full", compact ? "size-5" : "size-7")} />
				<div className="flex flex-1 flex-col gap-1.5">
					<Skeleton className="h-3 w-1/2" />
					{compact ? null : <Skeleton className="h-3 w-2/3" />}
				</div>
			</div>
			{compact ? null : <Skeleton className="h-3 w-full" />}
		</div>
	)
}

// An optional call-to-action shown beneath an error message, linking into the
// integrations area: "connect" → the catalog (no provider yet), "manage" → the
// GitHub card (a provider is connected but this commit's repo may not be shared).
type CommitMessageAction = "connect" | "manage"

function CommitMessage({
	title,
	detail,
	action,
	compact = false,
}: {
	title: string
	detail?: string
	action?: CommitMessageAction
	compact?: boolean
}) {
	return (
		<div className={cn("flex flex-col gap-1.5", compact ? "p-2.5" : "p-3.5")}>
			<p className="font-medium text-foreground">{title}</p>
			{detail ? (
				<p className={cn("text-muted-foreground", compact && "line-clamp-3")}>{detail}</p>
			) : null}
			{action === "connect" ? (
				<Link
					to="/integrations"
					className="mt-0.5 inline-flex w-fit items-center gap-1 font-medium text-primary hover:underline"
				>
					Connect a repository
					<span aria-hidden>→</span>
				</Link>
			) : action === "manage" ? (
				<Link
					to="/integrations"
					search={{ integration: "github" }}
					className="mt-0.5 inline-flex w-fit items-center gap-1 font-medium text-primary hover:underline"
				>
					Manage repository access
					<span aria-hidden>→</span>
				</Link>
			) : null}
		</div>
	)
}

// Map a resolved error to a graceful, non-alarming message. The invalid-SHA case
// is guarded client-side too (FULL_SHA), but a server-side
// VcsCommitShaInvalidError is handled here as defense-in-depth.
function describeError(error: unknown): {
	title: string
	detail?: string
	action?: CommitMessageAction
} {
	const tag =
		typeof error === "object" && error !== null && "_tag" in error
			? String((error as { _tag: unknown })._tag)
			: ""
	if (tag.endsWith("VcsCommitShaInvalidError")) {
		return { title: "Non-standard commit reference", detail: "Not a resolvable git SHA." }
	}
	if (tag.endsWith("VcsCommitNotFoundError")) {
		// Not "please wait" — a backfilled repo would already have this commit. The
		// likely cause is that the commit's repository isn't connected (or its access
		// was revoked), so point the user at fixing repository access.
		return {
			title: "Commit not found",
			detail: "Maple has no record of this commit. Make sure its repository is connected and Maple still has access to it.",
			action: "manage",
		}
	}
	if (tag.endsWith("IntegrationsNotConnectedError")) {
		return {
			title: "No repository connected",
			detail: "Connect a repository so Maple can resolve commits to their author, message, and repo.",
			action: "connect",
		}
	}
	return { title: "Couldn't load commit", detail: "Try again in a moment." }
}

// Absolute timestamp for the title tooltip on a relative age — e.g.
// "Jun 27, 2026, 3:42 PM". The relative label stays the at-a-glance value; the
// exact time is one hover away.
function formatExact(epochMs: number): string {
	return new Date(epochMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

/**
 * Relative age off a single threshold ladder (s/m/h/d/mo/y).
 *
 *  - Default: the full "3h ago" form, with a seconds tier and a "just now" floor.
 *  - `short`: the compact "3h" form (no suffix, sub-minute collapses to "now") for
 *    the dense commit-list rows where horizontal space is tight.
 */
function formatRelative(epochMs: number, { short = false }: { short?: boolean } = {}): string {
	const diff = Date.now() - epochMs
	const suffix = short ? "" : " ago"
	// Sub-minute floor. Default shows a live seconds tier ("Ns ago", "just now" for a
	// clock-skewed future timestamp); short collapses everything under a minute (incl.
	// a negative diff) to "now" since the dense list rows have no room for a seconds tier.
	if (diff < 60_000) {
		if (short) return "now"
		if (diff < 0) return "just now"
		return `${Math.floor(diff / 1000)}s${suffix}`
	}
	// Coarsening ladder from minutes up: the first unit whose next boundary the diff
	// hasn't reached wins (60m→1h, 24h→1d, 30d→1mo, 12mo→1y). `y` uses /365 days, not
	// /12 months, matching the original.
	const days = Math.floor(diff / 86_400_000)
	for (const { limit, div, unit } of RELATIVE_TIERS) {
		const value = Math.floor(diff / div)
		if (value < limit) return `${value}${unit}${suffix}`
	}
	return `${Math.floor(days / 365)}y${suffix}`
}

// Minutes-and-up tiers for `formatRelative`, finest unit first. Each entry's
// `value = floor(diff / div)` is emitted when it's still under `limit` (the point at
// which the next-coarser unit takes over). The sub-minute tier and the final years
// fallback are handled inline (they don't fit the uniform `floor(diff/div)` shape).
const RELATIVE_TIERS = [
	{ limit: 60, div: 60_000, unit: "m" }, // < 60 minutes
	{ limit: 24, div: 3_600_000, unit: "h" }, // < 24 hours
	{ limit: 30, div: 86_400_000, unit: "d" }, // < 30 days
	{ limit: 12, div: 2_592_000_000, unit: "mo" }, // < 12 months (30-day months)
] as const
