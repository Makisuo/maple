import { useState } from "react"

import type { ErrorIssuePullRequestDocument } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
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
import { cn } from "@maple/ui/lib/utils"

import { GithubIcon, PlusIcon, TrashIcon } from "@/components/icons"

/**
 * Pull requests attached to this issue.
 *
 * The link is what turns a fix into something Maple can follow up on: when a
 * listed PR merges, a verification window opens and the issue is checked
 * against real traffic rather than waiting for someone to remember it. The
 * panel says so on the empty state, because "attach a PR" is otherwise a
 * chore with no visible payoff.
 */

const STATE_TONE: Record<ErrorIssuePullRequestDocument["state"], string> = {
	open: "bg-success/10 text-success",
	merged: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
	closed: "bg-muted text-muted-foreground",
} satisfies Record<ErrorIssuePullRequestDocument["state"], string>

const SOURCE_HINT: Record<ErrorIssuePullRequestDocument["linkSource"], string | null> = {
	user: null,
	agent: "attached by an agent",
	auto: "found in the pull request description",
} satisfies Record<ErrorIssuePullRequestDocument["linkSource"], string | null>

export function IssuePullRequestsPanel({
	pullRequests,
	onLink,
	onUnlink,
	busy = false,
}: {
	pullRequests: ReadonlyArray<ErrorIssuePullRequestDocument>
	onLink: (url: string) => void
	onUnlink: (id: ErrorIssuePullRequestDocument["id"]) => void
	busy?: boolean
}) {
	const [open, setOpen] = useState(false)
	const [url, setUrl] = useState("")

	const submit = () => {
		const trimmed = url.trim()
		if (trimmed.length === 0) return
		onLink(trimmed)
		setUrl("")
		setOpen(false)
	}

	return (
		<section className="rounded-xl border bg-card">
			<header className="flex items-center justify-between gap-2 border-b px-4 py-3">
				<h2 className="text-sm font-medium text-foreground">Pull requests</h2>
				<Button
					size="sm"
					variant="ghost"
					className="h-7 gap-1 px-2 text-xs"
					onClick={() => setOpen(true)}
					disabled={busy}
				>
					<PlusIcon className="size-3.5" />
					Attach
				</Button>
			</header>

			{pullRequests.length === 0 ? (
				<p className="px-4 py-3 text-xs text-muted-foreground">
					Attach the pull request that fixes this. When it merges, Maple watches for the error to
					come back and closes this issue if it doesn&apos;t.
				</p>
			) : (
				<ul className="divide-y">
					{pullRequests.map((pr) => {
						const hint = SOURCE_HINT[pr.linkSource]
						return (
							<li key={pr.id} className="group flex items-start gap-3 px-4 py-3">
								<GithubIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-2">
										<a
											href={pr.url}
											target="_blank"
											rel="noreferrer"
											className="truncate text-sm font-medium text-foreground hover:underline"
										>
											{pr.repoFullName}#{pr.number}
										</a>
										<Badge
											variant="outline"
											className={cn("shrink-0 capitalize", STATE_TONE[pr.state])}
										>
											{pr.state}
										</Badge>
									</div>
									{pr.title ? (
										<p className="mt-0.5 truncate text-xs text-muted-foreground">
											{pr.title}
										</p>
									) : null}
									{hint ? (
										<p className="mt-0.5 text-xs text-muted-foreground/80">{hint}</p>
									) : null}
								</div>
								<Button
									size="icon"
									variant="ghost"
									aria-label={`Detach ${pr.repoFullName}#${pr.number}`}
									className="size-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
									onClick={() => onUnlink(pr.id)}
									disabled={busy}
								>
									<TrashIcon className="size-3.5" />
								</Button>
							</li>
						)
					})}
				</ul>
			)}

			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Attach a pull request</DialogTitle>
						<DialogDescription>
							Paste the pull request URL. Once it merges, Maple checks whether this error
							actually stopped before closing the issue.
						</DialogDescription>
					</DialogHeader>
					<DialogPanel>
						<Input
							value={url}
							autoFocus
							placeholder="https://github.com/owner/repo/pull/123"
							onChange={(event) => setUrl(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") submit()
							}}
						/>
					</DialogPanel>
					<DialogFooter>
						<Button variant="outline" onClick={() => setOpen(false)}>
							Cancel
						</Button>
						<Button onClick={submit} disabled={url.trim().length === 0 || busy}>
							Attach
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</section>
	)
}
