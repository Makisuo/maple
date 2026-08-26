import { useMemo, useState } from "react"

import { parsePullRequestUrl, VCS_PULL_REQUESTS_DEFAULT_LIMIT } from "@maple/domain/http"
import type { PullRequestSummary } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import {
	Combobox,
	ComboboxContent,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "@maple/ui/components/ui/combobox"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { cn } from "@maple/ui/lib/utils"

import { Result, useAtomValue } from "@/lib/effect-atom"
import { retainedQuery } from "@/lib/services/common/atom-client"

/**
 * Picking the pull request that fixes an issue.
 *
 * The old version of this was one input asking for a `https://github.com/…/pull/N`
 * URL, which meant leaving Maple, finding the PR, copying, and coming back —
 * while Maple already had the org's repositories synced and could simply have
 * offered the PR. So the picker is the path, and pasting is kept as the escape
 * hatch it should always have been: it is the only way to attach a PR in a
 * repository this org has not connected, which the link table deliberately
 * supports.
 */

export const PULL_REQUEST_STATE_TONE = {
	open: "bg-success/10 text-success",
	merged: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
	closed: "bg-muted text-muted-foreground",
} satisfies Record<PullRequestSummary["state"], string>

/** `#123`, `123`, or a full PR URL — the three things a person actually types. */
const resolveTypedReference = (
	input: string,
	repository: string | null,
): string | null => {
	const trimmed = input.trim()
	if (trimmed.length === 0) return null

	const parsed = parsePullRequestUrl(trimmed)
	if (parsed !== null) return parsed.url

	// A bare number only means something once a repository is selected.
	const bare = /^#?(\d+)$/.exec(trimmed)
	if (bare === null || repository === null) return null
	const number = Number.parseInt(bare[1] ?? "", 10)
	if (!Number.isSafeInteger(number) || number <= 0) return null
	return `https://github.com/${repository}/pull/${number}`
}

const matchesFilter = (pr: PullRequestSummary, filter: string): boolean => {
	const needle = filter.trim().toLowerCase()
	if (needle.length === 0) return true
	return (
		pr.title.toLowerCase().includes(needle) ||
		String(pr.number).includes(needle.replace("#", "")) ||
		pr.headRef.toLowerCase().includes(needle) ||
		(pr.authorLogin ?? "").toLowerCase().includes(needle)
	)
}

export function AttachPullRequestDialog({
	open,
	onOpenChange,
	suggestedRepository,
	onAttach,
	busy = false,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	/** Where the picker opens. Null when Maple could not guess. */
	suggestedRepository: string | null
	/** Resolves to whether the link landed, so a failure keeps the dialog open. */
	onAttach: (url: string) => Promise<boolean>
	busy?: boolean
}) {
	const [overrideRepository, setOverrideRepository] = useState<string | null>(null)
	const [filter, setFilter] = useState("")

	const statusResult = useAtomValue(
		retainedQuery("integrations", "githubStatus", { reactivityKeys: ["githubStatus"] }),
	)
	const status = Result.builder(statusResult)
		.onSuccess((value) => value)
		.orElse(() => null)
	const connected = status?.state === "connected"
	const repositories = useMemo(
		() => (status?.repositories ?? []).filter((repo) => repo.status === "active"),
		[status],
	)

	// The suggestion only holds while it is still a repository the org has; a
	// repo disconnected mid-session must not leave the picker pointing at it.
	const selectedRepository =
		overrideRepository ??
		(suggestedRepository !== null && repositories.some((r) => r.fullName === suggestedRepository)
			? suggestedRepository
			: (repositories[0]?.fullName ?? null))

	const pullRequestsResult = useAtomValue(
		retainedQuery("integrations", "vcsPullRequests", {
			// The query still has to be well-formed when there is nothing to ask
			// about; the list below is gated on `connected` and a real selection.
			query: {
				repository: selectedRepository ?? "",
				limit: VCS_PULL_REQUESTS_DEFAULT_LIMIT,
			},
			reactivityKeys: [`vcsPullRequests:${selectedRepository ?? "none"}`],
		}),
	)
	const loadingPullRequests = connected && selectedRepository !== null && pullRequestsResult.waiting
	const pullRequests = Result.builder(pullRequestsResult)
		.onSuccess((value) => value.pullRequests)
		.orElse(() => [])
	const visible = useMemo(
		() => pullRequests.filter((pr) => matchesFilter(pr, filter)),
		[pullRequests, filter],
	)

	const typedUrl = resolveTypedReference(filter, selectedRepository)

	const close = () => {
		setFilter("")
		setOverrideRepository(null)
		onOpenChange(false)
	}

	// Awaited before closing: clearing the field and dismissing the dialog up
	// front means a failure toast arrives with what the user typed already gone,
	// and recovery is a trip back to GitHub to find the pull request again.
	const attach = async (url: string) => {
		if (busy) return
		const linked = await onAttach(url)
		if (linked) close()
	}

	return (
		<Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Attach a pull request</DialogTitle>
					<DialogDescription>
						Once it merges, Maple checks whether this error actually stopped before closing
						the issue.
					</DialogDescription>
				</DialogHeader>

				<DialogPanel className="space-y-3">
					{!connected ? (
						<div className="space-y-2">
							<Input
								value={filter}
								autoFocus
								placeholder="https://github.com/owner/repo/pull/123"
								onChange={(event) => setFilter(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter" && typedUrl !== null) void attach(typedUrl)
								}}
							/>
							<p className="text-xs text-muted-foreground">
								<a href="/settings/integrations" className="underline hover:no-underline">
									Connect GitHub
								</a>{" "}
								to pick from your repositories instead of pasting a link.
							</p>
						</div>
					) : (
						<>
							{repositories.length > 1 ? (
								<div className="space-y-1.5">
									<Label className="text-xs text-muted-foreground">Repository</Label>
									<Select
										value={selectedRepository}
										onValueChange={(value) => {
											setOverrideRepository(value)
											setFilter("")
										}}
									>
										<SelectTrigger size="sm" className="w-full text-xs">
											<SelectValue placeholder="Pick a repository" />
										</SelectTrigger>
										<SelectContent>
											{repositories.map((repo) => (
												<SelectItem key={repo.id} value={repo.fullName}>
													{repo.fullName}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							) : null}

							<div className="space-y-1.5">
								<Label className="text-xs text-muted-foreground">Pull request</Label>
								<Combobox
									value={null}
									onValueChange={(value) => {
										if (typeof value === "string") void attach(value)
									}}
								>
									<ComboboxInput
										autoFocus
										placeholder="Search by title, number, branch, or paste a link"
										className="w-full text-xs"
										value={filter}
										onChange={(event) => setFilter(event.target.value)}
										onKeyDown={(event) => {
											if (event.key === "Enter" && typedUrl !== null) {
												event.preventDefault()
												void attach(typedUrl)
											}
										}}
									/>
									<ComboboxContent>
										{loadingPullRequests ? (
											<div className="py-4 text-center text-xs text-muted-foreground">
												Loading pull requests…
											</div>
										) : visible.length === 0 ? (
											<div className="py-4 text-center text-xs text-muted-foreground">
												{typedUrl !== null
													? "Press Enter to attach the pull request you typed."
													: pullRequests.length === 0
														? "No pull requests in this repository yet."
														: "Nothing matches that search."}
											</div>
										) : (
											<ComboboxList>
												{visible.map((pr) => (
													<ComboboxItem key={pr.number} value={pr.url}>
														<div className="flex min-w-0 flex-col gap-0.5">
															<div className="flex items-center gap-2">
																<span className="truncate text-xs font-medium">
																	#{pr.number} {pr.title}
																</span>
																<Badge
																	variant="outline"
																	className={cn(
																		"shrink-0 capitalize",
																		PULL_REQUEST_STATE_TONE[pr.state],
																	)}
																>
																	{pr.isDraft && pr.state === "open"
																		? "draft"
																		: pr.state}
																</Badge>
															</div>
															<span className="truncate text-[11px] text-muted-foreground">
																{pr.headRef}
																{pr.authorLogin
																	? ` · ${pr.authorLogin}`
																	: ""}
															</span>
														</div>
													</ComboboxItem>
												))}
											</ComboboxList>
										)}
									</ComboboxContent>
								</Combobox>
							</div>
						</>
					)}
				</DialogPanel>

				<DialogFooter>
					<Button variant="outline" onClick={close}>
						Cancel
					</Button>
					<Button
						onClick={() => {
							if (typedUrl !== null) void attach(typedUrl)
						}}
						disabled={typedUrl === null || busy}
					>
						Attach
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
