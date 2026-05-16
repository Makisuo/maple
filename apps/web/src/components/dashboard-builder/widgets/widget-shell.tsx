import type { ReactNode } from "react"
import {
	GripDotsIcon,
	TrashIcon,
	PencilIcon,
	CopyIcon,
	DotsVerticalIcon,
	ChatBubbleSparkleIcon,
	BellIcon,
} from "@/components/icons"

import { Card, CardContent, CardHeader, CardTitle, CardAction } from "@maple/ui/components/ui/card"
import { Button } from "@maple/ui/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
} from "@maple/ui/components/ui/dropdown-menu"
import type { WidgetMode, WidgetDataState } from "@/components/dashboard-builder/types"
import { useWidgetActions } from "@/components/dashboard-builder/widgets/widget-actions-context"

interface WidgetShellProps {
	title: string
	mode: WidgetMode
	/**
	 * Action callbacks. When omitted, they fall back to the nearest
	 * `WidgetActionsProvider`; explicit props override context (used by the
	 * widget lab, which renders widgets outside a dashboard provider).
	 */
	onRemove?: () => void
	onClone?: () => void
	onConfigure?: () => void
	/** When set, a "Create alert" menu item is shown (in edit and view mode). */
	onCreateAlert?: () => void
	contentClassName?: string
	children: ReactNode
}

export function WidgetShell({
	title,
	mode,
	onRemove,
	onClone,
	onConfigure,
	onCreateAlert,
	contentClassName,
	children,
}: WidgetShellProps) {
	const ctx = useWidgetActions()
	const remove = onRemove ?? ctx?.remove
	const clone = onClone ?? ctx?.clone
	const configure = onConfigure ?? ctx?.configure
	const createAlert = onCreateAlert ?? ctx?.createAlert
	const isEditable = mode === "edit"
	// The menu is also shown in view mode when "Create alert" is available, so
	// alerts can be spun off a chart without entering dashboard edit mode.
	const showMenu = isEditable || createAlert != null

	return (
		<Card className="h-full flex flex-col">
			<CardHeader className="border-b py-2">
				<div className="flex items-center gap-2">
					{isEditable && (
						<div className="widget-drag-handle cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground">
							<GripDotsIcon size={14} />
						</div>
					)}
					<CardTitle className="flex-1 truncate text-xs">{title}</CardTitle>
				</div>
				{showMenu && (
					<CardAction>
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button variant="ghost" size="icon-xs">
										<DotsVerticalIcon size={14} />
									</Button>
								}
							/>
							<DropdownMenuContent align="end">
								{isEditable && configure && (
									<DropdownMenuItem onClick={configure}>
										<PencilIcon size={14} />
										Edit
									</DropdownMenuItem>
								)}
								{isEditable && clone && (
									<DropdownMenuItem onClick={clone}>
										<CopyIcon size={14} />
										Clone
									</DropdownMenuItem>
								)}
								{createAlert && (
									<DropdownMenuItem onClick={createAlert}>
										<BellIcon size={14} />
										Create alert
									</DropdownMenuItem>
								)}
								{isEditable && remove && (
									<>
										<DropdownMenuSeparator />
										<DropdownMenuItem variant="destructive" onClick={remove}>
											<TrashIcon size={14} />
											Delete
										</DropdownMenuItem>
									</>
								)}
							</DropdownMenuContent>
						</DropdownMenu>
					</CardAction>
				)}
			</CardHeader>
			<CardContent className={contentClassName ?? "flex-1 min-h-0 p-2"}>{children}</CardContent>
		</Card>
	)
}

export function ReadonlyWidgetShell(props: Omit<WidgetShellProps, "mode">) {
	return <WidgetShell {...props} mode="view" />
}

interface WidgetFrameProps {
	title: string
	dataState: WidgetDataState
	mode: WidgetMode
	/**
	 * Action callbacks. When omitted, they fall back to the nearest
	 * `WidgetActionsProvider`; explicit props override context (used by the
	 * widget lab, which renders widgets outside a dashboard provider).
	 */
	onRemove?: () => void
	onClone?: () => void
	onConfigure?: () => void
	onCreateAlert?: () => void
	onFix?: () => void
	contentClassName?: string
	loadingSkeleton: ReactNode
	children: ReactNode
}

export function WidgetFrame({
	title,
	dataState,
	mode,
	onRemove,
	onClone,
	onConfigure,
	onCreateAlert,
	onFix,
	contentClassName,
	loadingSkeleton,
	children,
}: WidgetFrameProps) {
	// `WidgetShell` resolves the menu actions against context itself; `fix`
	// drives the inline error CTA below, so it is resolved here too.
	const ctx = useWidgetActions()
	const fix = onFix ?? ctx?.fix

	return (
		<WidgetShell
			title={title}
			mode={mode}
			onRemove={onRemove}
			onClone={onClone}
			onConfigure={onConfigure}
			onCreateAlert={onCreateAlert}
			contentClassName={contentClassName}
		>
			{dataState.status === "loading" ? (
				loadingSkeleton
			) : dataState.status === "error" ? (
				dataState.message === "No query data found in selected time range" ? (
					<div className="flex items-center justify-center h-full">
						<span className="text-xs text-muted-foreground">No data in selected time range</span>
					</div>
				) : (
					<div className="flex items-center justify-center h-full flex-col gap-1.5 px-3">
						<span className="text-xs font-medium text-destructive">
							{dataState.title ?? "Unable to load"}
						</span>
						{dataState.message && (
							<span className="text-[10px] text-destructive/70 max-w-full text-center line-clamp-2">
								{dataState.message}
							</span>
						)}
						{fix && dataState.kind === "decode" && (
							<Button
								variant="outline"
								size="xs"
								onClick={fix}
								className="mt-1 h-6 gap-1 text-[10px]"
							>
								<ChatBubbleSparkleIcon size={12} />
								Fix with AI
							</Button>
						)}
					</div>
				)
			) : (
				children
			)}
		</WidgetShell>
	)
}
