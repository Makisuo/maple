import type { ReactNode } from "react"
import {
	GripDotsIcon,
	TrashIcon,
	PencilIcon,
	CopyIcon,
	DotsVerticalIcon,
	ChatBubbleSparkleIcon,
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

interface WidgetShellProps {
	title: string
	mode: WidgetMode
	onRemove?: () => void
	onClone?: () => void
	onConfigure?: () => void
	contentClassName?: string
	children: ReactNode
}

export function WidgetShell({
	title,
	mode,
	onRemove,
	onClone,
	onConfigure,
	contentClassName,
	children,
}: WidgetShellProps) {
	const isEditable = mode === "edit"

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
				{isEditable && (
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
								{onConfigure && (
									<DropdownMenuItem onClick={onConfigure}>
										<PencilIcon size={14} />
										Edit
									</DropdownMenuItem>
								)}
								{onClone && (
									<DropdownMenuItem onClick={onClone}>
										<CopyIcon size={14} />
										Clone
									</DropdownMenuItem>
								)}
								{onRemove && (
									<>
										<DropdownMenuSeparator />
										<DropdownMenuItem variant="destructive" onClick={onRemove}>
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
	onRemove: () => void
	onClone?: () => void
	onConfigure?: () => void
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
	onFix,
	contentClassName,
	loadingSkeleton,
	children,
}: WidgetFrameProps) {
	return (
		<WidgetShell
			title={title}
			mode={mode}
			onRemove={onRemove}
			onClone={onClone}
			onConfigure={onConfigure}
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
						{onFix && dataState.kind === "decode" && (
							<Button
								variant="outline"
								size="xs"
								onClick={onFix}
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
