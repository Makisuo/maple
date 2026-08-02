import { useState } from "react"

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
import { Label } from "@maple/ui/components/ui/label"

import { PlusIcon, XmarkIcon } from "@/components/icons"

/** Longest tag we store. Long enough for `checkout-service-slo`, short enough that
 *  the list's Tags menu and the filter chips never wrap. */
const MAX_TAG_LENGTH = 32

/**
 * The single normalisation both call sites share, so the list's Tags menu never
 * shows near-duplicates (`API` next to `api `). Case-folding is the important
 * part: `matchesTags` compares tags exactly, so an unfolded `API` would be
 * unreachable from a filter chip that says `api`.
 */
export function normalizeTags(input: ReadonlyArray<string>): string[] {
	const seen = new Set<string>()
	for (const raw of input) {
		const tag = raw.trim().toLowerCase().slice(0, MAX_TAG_LENGTH)
		if (tag !== "") seen.add(tag)
	}
	return Array.from(seen).sort()
}

/** Splits pasted or typed input on the separators users actually reach for. */
const splitInput = (value: string): string[] => value.split(/[,\n]/)

export function TagEditorDialog({
	open,
	onOpenChange,
	dashboardName,
	tags,
	suggestions = [],
	onSave,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	dashboardName: string
	tags: ReadonlyArray<string>
	/** Tags already in use across the org — offered as one-click adds. */
	suggestions?: ReadonlyArray<string>
	onSave: (tags: string[]) => void
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				{/* Mounted only while open so each session starts from the saved tags,
				    matching `VariablesManagerDialog`. */}
				{open && (
					<TagEditor
						dashboardName={dashboardName}
						initial={tags}
						suggestions={suggestions}
						onCancel={() => onOpenChange(false)}
						onSave={(next) => {
							onSave(next)
							onOpenChange(false)
						}}
					/>
				)}
			</DialogContent>
		</Dialog>
	)
}

function TagEditor({
	dashboardName,
	initial,
	suggestions,
	onCancel,
	onSave,
}: {
	dashboardName: string
	initial: ReadonlyArray<string>
	suggestions: ReadonlyArray<string>
	onCancel: () => void
	onSave: (tags: string[]) => void
}) {
	const [drafts, setDrafts] = useState<string[]>(() => normalizeTags(initial))
	const [pending, setPending] = useState("")

	const commit = (value: string) => {
		const added = normalizeTags(splitInput(value))
		if (added.length === 0) return
		setDrafts((prev) => normalizeTags([...prev, ...added]))
		setPending("")
	}

	const remove = (tag: string) => setDrafts((prev) => prev.filter((t) => t !== tag))

	// Only tags this dashboard doesn't already carry are worth a click.
	const unused = normalizeTags(suggestions).filter((tag) => !drafts.includes(tag))

	return (
		<>
			<DialogHeader>
				<DialogTitle>Tags</DialogTitle>
				<DialogDescription>
					Group <span className="text-foreground">{dashboardName}</span> with related dashboards.
					Tags drive the Tags filter on the dashboards list.
				</DialogDescription>
			</DialogHeader>
			<DialogPanel className="flex flex-col gap-3">
				<div className="flex flex-col gap-1.5">
					<Label className="text-xs" htmlFor="tag-editor-input">
						Add a tag
					</Label>
					<div className="flex items-center gap-1.5">
						<Input
							id="tag-editor-input"
							size="sm"
							value={pending}
							placeholder="slo, api, team-platform"
							maxLength={MAX_TAG_LENGTH}
							onChange={(event) => setPending(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === ",") {
									// Enter must not reach the dialog's default submit — the
									// pending tag isn't saved yet.
									event.preventDefault()
									commit(pending)
									return
								}
								// Backspace on an empty field pops the last chip, the
								// convention every tag input shares.
								if (event.key === "Backspace" && pending === "" && drafts.length > 0) {
									event.preventDefault()
									remove(drafts[drafts.length - 1]!)
								}
							}}
							// Committing on blur means a typed tag is never silently lost by
							// clicking Save directly.
							onBlur={() => commit(pending)}
						/>
						<Button
							variant="outline"
							size="icon-sm"
							aria-label="Add tag"
							disabled={normalizeTags(splitInput(pending)).length === 0}
							onClick={() => commit(pending)}
						>
							<PlusIcon size={14} />
						</Button>
					</div>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label className="text-xs">On this dashboard</Label>
					{drafts.length === 0 ? (
						<p className="text-muted-foreground text-[11px]">
							No tags yet — this dashboard won't appear under any Tags filter.
						</p>
					) : (
						<div className="flex flex-wrap gap-1">
							{drafts.map((tag) => (
								<Badge
									key={tag}
									variant="secondary"
									className="gap-1 pr-1 font-mono text-[11px]"
								>
									{tag}
									<Button
										variant="ghost"
										size="icon-xs"
										aria-label={`Remove tag ${tag}`}
										className="size-4 text-muted-foreground hover:text-foreground"
										onClick={() => remove(tag)}
									>
										<XmarkIcon size={11} />
									</Button>
								</Badge>
							))}
						</div>
					)}
				</div>

				{unused.length > 0 && (
					<div className="flex flex-col gap-1.5">
						<Label className="text-xs">Used elsewhere</Label>
						<div className="flex flex-wrap gap-1">
							{unused.map((tag) => (
								<Button
									key={tag}
									variant="outline"
									size="xs"
									className="font-mono text-[11px]"
									onClick={() => commit(tag)}
								>
									<PlusIcon size={10} data-icon="inline-start" />
									{tag}
								</Button>
							))}
						</div>
					</div>
				)}
			</DialogPanel>
			<DialogFooter>
				<Button variant="outline" size="sm" onClick={onCancel}>
					Cancel
				</Button>
				{/* Commits `pending` first: onBlur fires before click on most browsers
				    but not all, and losing a just-typed tag on Save is unforgiving. */}
				<Button size="sm" onClick={() => onSave(normalizeTags([...drafts, ...splitInput(pending)]))}>
					Save
				</Button>
			</DialogFooter>
		</>
	)
}
