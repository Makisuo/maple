import { useMemo, useRef, useState, useEffect, type KeyboardEvent } from "react"
import type { ChatTab } from "@/hooks/use-chat-tabs"
import { cn } from "@maple/ui/lib/utils"
import { Button } from "@maple/ui/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import {
	BellIcon,
	ChartLineIcon,
	DotsIcon,
	PencilIcon,
	PlusIcon,
	TrashIcon,
} from "@/components/icons"
import { DotmSquare4 } from "@/components/ui/dotm-square-4"

interface ChatSidebarProps {
	tabs: ChatTab[]
	activeTabId: string | null
	loadingTabIds?: ReadonlySet<string>
	onSelect: (id: string) => void
	onClose: (id: string) => void
	onCreate: () => void
	onRename: (id: string, title: string) => void
}

interface TabGroup {
	label: string
	tabs: ChatTab[]
}

const DAY_MS = 24 * 60 * 60 * 1000

function startOfDay(ts: number): number {
	const d = new Date(ts)
	d.setHours(0, 0, 0, 0)
	return d.getTime()
}

function groupTabs(tabs: ChatTab[], now: number): TabGroup[] {
	const todayStart = startOfDay(now)
	const yesterdayStart = todayStart - DAY_MS
	const sevenDaysAgoStart = todayStart - 7 * DAY_MS

	const today: ChatTab[] = []
	const yesterday: ChatTab[] = []
	const previous7: ChatTab[] = []
	const older: ChatTab[] = []

	for (const tab of tabs) {
		const ts = tab.updatedAt
		if (ts >= todayStart) today.push(tab)
		else if (ts >= yesterdayStart) yesterday.push(tab)
		else if (ts >= sevenDaysAgoStart) previous7.push(tab)
		else older.push(tab)
	}

	const byRecency = (a: ChatTab, b: ChatTab) => b.updatedAt - a.updatedAt

	return [
		{ label: "Today", tabs: today.sort(byRecency) },
		{ label: "Yesterday", tabs: yesterday.sort(byRecency) },
		{ label: "Previous 7 days", tabs: previous7.sort(byRecency) },
		{ label: "Older", tabs: older.sort(byRecency) },
	].filter((g) => g.tabs.length > 0)
}

function tabIcon(tab: ChatTab) {
	if (tab.id.startsWith("alert-")) return BellIcon
	if (tab.id.startsWith("widget-fix-")) return ChartLineIcon
	return null
}

export function ChatSidebar({
	tabs,
	activeTabId,
	loadingTabIds,
	onSelect,
	onClose,
	onCreate,
	onRename,
}: ChatSidebarProps) {
	const groups = useMemo(() => groupTabs(tabs, Date.now()), [tabs])
	const canDelete = tabs.length > 1
	const [renamingId, setRenamingId] = useState<string | null>(null)

	return (
		<aside
			className="flex w-[260px] shrink-0 flex-col overflow-hidden border-r bg-sidebar text-sidebar-foreground"
			aria-label="Chat conversations"
		>
			<div className="flex w-[260px] flex-1 flex-col">
				<div className="p-3">
					<Button onClick={onCreate} size="sm" className="w-full justify-start gap-2 font-medium">
						<PlusIcon size={14} />
						New chat
					</Button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
					{groups.length === 0 ? (
						<div className="px-2 py-6 text-center text-xs text-sidebar-foreground/60">
							No conversations yet
						</div>
					) : (
						groups.map((group) => (
							<div key={group.label} className="mb-3">
								<div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-sidebar-foreground/60">
									{group.label}
								</div>
								<ul className="flex flex-col gap-0.5">
									{group.tabs.map((tab) => (
										<ChatSidebarRow
											key={tab.id}
											tab={tab}
											isActive={tab.id === activeTabId}
											isLoading={loadingTabIds?.has(tab.id) ?? false}
											isRenaming={renamingId === tab.id}
											canDelete={canDelete}
											onSelect={onSelect}
											onClose={onClose}
											onRename={(id, title) => {
												onRename(id, title)
												setRenamingId(null)
											}}
											onStartRename={() => setRenamingId(tab.id)}
											onCancelRename={() => setRenamingId(null)}
										/>
									))}
								</ul>
							</div>
						))
					)}
				</div>
			</div>
		</aside>
	)
}

interface ChatSidebarRowProps {
	tab: ChatTab
	isActive: boolean
	isLoading: boolean
	isRenaming: boolean
	canDelete: boolean
	onSelect: (id: string) => void
	onClose: (id: string) => void
	onRename: (id: string, title: string) => void
	onStartRename: () => void
	onCancelRename: () => void
}

function ChatSidebarRow({
	tab,
	isActive,
	isLoading,
	isRenaming,
	canDelete,
	onSelect,
	onClose,
	onRename,
	onStartRename,
	onCancelRename,
}: ChatSidebarRowProps) {
	const Icon = tabIcon(tab)
	const inputRef = useRef<HTMLInputElement>(null)
	const [draft, setDraft] = useState(tab.title)

	useEffect(() => {
		if (isRenaming) {
			setDraft(tab.title)
			requestAnimationFrame(() => {
				inputRef.current?.focus()
				inputRef.current?.select()
			})
		}
	}, [isRenaming, tab.title])

	const commit = () => {
		const trimmed = draft.trim()
		if (trimmed.length > 0 && trimmed !== tab.title) {
			onRename(tab.id, trimmed)
		} else {
			onCancelRename()
		}
	}

	const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			e.preventDefault()
			commit()
		} else if (e.key === "Escape") {
			e.preventDefault()
			onCancelRename()
		}
	}

	const handleRowClick = () => {
		if (isRenaming) return
		onSelect(tab.id)
	}

	const handleRowKey = (e: KeyboardEvent<HTMLDivElement>) => {
		if (isRenaming) return
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault()
			onSelect(tab.id)
		}
	}

	return (
		<li>
			<div
				role={isRenaming ? undefined : "button"}
				tabIndex={isRenaming ? undefined : 0}
				onClick={handleRowClick}
				onDoubleClick={isRenaming ? undefined : onStartRename}
				onKeyDown={handleRowKey}
				className={cn(
					"group relative flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors",
					!isRenaming && "cursor-pointer",
					isActive
						? "bg-sidebar-accent text-sidebar-accent-foreground"
						: "text-sidebar-foreground/85 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
				)}
			>
				{isLoading ? (
					<DotmSquare4
						size={14}
						dotSize={2}
						color="var(--primary)"
						className="shrink-0"
						ariaLabel="Working"
					/>
				) : Icon ? (
					<Icon size={14} className="shrink-0 opacity-70" />
				) : null}
				{isRenaming ? (
					<input
						ref={inputRef}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onBlur={commit}
						onKeyDown={handleKey}
						onClick={(e) => e.stopPropagation()}
						className="min-w-0 flex-1 bg-transparent text-sm outline-none ring-1 ring-ring/50 rounded-sm px-1 -mx-1"
					/>
				) : (
					<span
						className="min-w-0 flex-1 truncate text-left"
						title={tab.title}
					>
						{tab.title}
					</span>
				)}
				{!isRenaming && (
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<button
									type="button"
									className={cn(
										"shrink-0 rounded-sm p-0.5 transition-opacity hover:bg-foreground/10",
										isActive
											? "opacity-60 hover:opacity-100"
											: "opacity-0 group-hover:opacity-60 hover:!opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
									)}
									aria-label={`Actions for ${tab.title}`}
									onClick={(e) => e.stopPropagation()}
								>
									<DotsIcon size={14} />
								</button>
							}
						/>
						<DropdownMenuContent side="right" align="start" sideOffset={4} className="min-w-36">
							<DropdownMenuItem onClick={onStartRename}>
								<PencilIcon size={14} />
								Rename
							</DropdownMenuItem>
							<DropdownMenuItem
								disabled={!canDelete}
								variant="destructive"
								onClick={() => {
									if (canDelete) onClose(tab.id)
								}}
							>
								<TrashIcon size={14} />
								Delete
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</div>
		</li>
	)
}
