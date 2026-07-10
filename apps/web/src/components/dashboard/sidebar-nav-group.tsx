import type * as React from "react"
import { Link } from "@tanstack/react-router"
import { MotionConfig, Reorder, useDragControls } from "motion/react"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import {
	SidebarGroup,
	SidebarGroupContent,
	SidebarMenu,
	SidebarMenuBadge,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
} from "@maple/ui/components/ui/sidebar"
import { cn } from "@maple/ui/utils"
import { EyeIcon, EyeSlashIcon, GripDotsIcon } from "@/components/icons"
import { LOCKED_NAV_IDS, applySidebarPrefs } from "@/atoms/sidebar-preferences-atoms"
import { useSidebarPreferences } from "@/hooks/use-sidebar-preferences"
import type { SidebarGroupId, SignalsNavItem } from "@/components/dashboard/nav-items"

export function NavItemRow({
	item,
	currentPath,
	exactMatch,
}: {
	item: SignalsNavItem
	currentPath: string
	exactMatch: boolean
}) {
	const isActive = exactMatch ? currentPath === item.href : currentPath.startsWith(item.href)
	return (
		<SidebarMenuItem>
			<SidebarMenuButton render={<Link to={item.href} />} tooltip={item.title} isActive={isActive}>
				<item.icon size={18} />
				<span>{item.title}</span>
			</SidebarMenuButton>
			{item.badge ? (
				<SidebarMenuBadge>
					<Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-medium">
						{item.badge}
					</Badge>
				</SidebarMenuBadge>
			) : null}
			{item.subItems && isActive ? (
				<SidebarMenuSub>
					{item.subItems.map((sub) => {
						const subActive =
							sub.href === item.href
								? currentPath === item.href || currentPath === `${item.href}/`
								: currentPath.startsWith(sub.href)
						return (
							<SidebarMenuSubItem key={sub.title}>
								<SidebarMenuSubButton render={<Link to={sub.href} />} isActive={subActive}>
									{sub.icon ? <sub.icon size={14} /> : null}
									<span>{sub.title}</span>
								</SidebarMenuSubButton>
							</SidebarMenuSubItem>
						)
					})}
				</SidebarMenuSub>
			) : null}
		</SidebarMenuItem>
	)
}

function EditableNavRow({
	item,
	hidden,
	locked,
	index,
	orderIds,
	onMove,
	onToggleHidden,
}: {
	item: SignalsNavItem
	hidden: boolean
	locked: boolean
	index: number
	orderIds: readonly string[]
	onMove: (ids: string[]) => void
	onToggleHidden: () => void
}) {
	const controls = useDragControls()

	const moveTo = (target: number) => {
		if (target < 0 || target >= orderIds.length || target === index) return
		const ids = orderIds.filter((id) => id !== item.id)
		ids.splice(target, 0, item.id)
		onMove(ids)
	}

	const handleGripKeyDown = (event: React.KeyboardEvent) => {
		const handlers: Record<string, () => void> = {
			ArrowUp: () => moveTo(index - 1),
			ArrowDown: () => moveTo(index + 1),
			Home: () => moveTo(0),
			End: () => moveTo(orderIds.length - 1),
		}
		const handler = handlers[event.key]
		if (handler) {
			event.preventDefault()
			handler()
		}
	}

	return (
		<Reorder.Item
			value={item.id}
			as="li"
			dragListener={false}
			dragControls={controls}
			className="group/menu-item relative flex items-center gap-0.5 rounded-md bg-sidebar"
			whileDrag={{ scale: 1.02, boxShadow: "0 4px 14px rgba(0,0,0,0.18)", zIndex: 50 }}
			transition={{ duration: 0.15 }}
		>
			{locked ? (
				<span className="size-6 shrink-0" />
			) : (
				<button
					type="button"
					aria-label={`Reorder ${item.title}`}
					className="flex size-6 shrink-0 items-center justify-center rounded-md cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring outline-none touch-none"
					onPointerDown={(e) => controls.start(e)}
					onKeyDown={handleGripKeyDown}
				>
					<GripDotsIcon size={14} />
				</button>
			)}
			<SidebarMenuButton
				tabIndex={-1}
				className={cn("pointer-events-none flex-1", hidden && "opacity-50")}
			>
				<item.icon size={18} />
				<span>{item.title}</span>
			</SidebarMenuButton>
			{locked ? (
				<span className="size-6 shrink-0" />
			) : (
				<button
					type="button"
					aria-label={hidden ? `Show ${item.title}` : `Hide ${item.title}`}
					aria-pressed={hidden}
					className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring outline-none"
					onClick={onToggleHidden}
				>
					{hidden ? <EyeSlashIcon size={14} /> : <EyeIcon size={14} />}
				</button>
			)}
		</Reorder.Item>
	)
}

export function SidebarNavGroup({
	groupId,
	items,
	currentPath,
	editing,
}: {
	groupId: SidebarGroupId
	items: readonly SignalsNavItem[]
	currentPath: string
	editing: boolean
}) {
	const { prefs, toggleHidden, setGroupOrder } = useSidebarPreferences()
	const rows = applySidebarPrefs(groupId, items, prefs)

	if (!editing) {
		const visible = rows.filter((row) => !row.hidden)
		if (visible.length === 0) return null
		return (
			<SidebarGroup>
				<SidebarGroupContent>
					<SidebarMenu>
						{visible.map(({ item }) => (
							<NavItemRow
								key={item.id}
								item={item}
								currentPath={currentPath}
								exactMatch={groupId === "main"}
							/>
						))}
					</SidebarMenu>
				</SidebarGroupContent>
			</SidebarGroup>
		)
	}

	const orderIds = rows.map((row) => row.item.id)
	return (
		<SidebarGroup>
			<SidebarGroupContent>
				<MotionConfig reducedMotion="user">
					<Reorder.Group
						axis="y"
						values={orderIds}
						onReorder={(ids: string[]) => setGroupOrder(groupId, ids)}
						as="ul"
						className="flex w-full min-w-0 flex-col gap-1"
					>
						{rows.map(({ item, hidden }, index) => (
							<EditableNavRow
								key={item.id}
								item={item}
								hidden={hidden}
								locked={LOCKED_NAV_IDS.has(item.id)}
								index={index}
								orderIds={orderIds}
								onMove={(ids) => setGroupOrder(groupId, ids)}
								onToggleHidden={() => toggleHidden(item.id)}
							/>
						))}
					</Reorder.Group>
				</MotionConfig>
			</SidebarGroupContent>
		</SidebarGroup>
	)
}

export function SidebarEditBar({
	isCustomized,
	onReset,
	onDone,
}: {
	isCustomized: boolean
	onReset: () => void
	onDone: () => void
}) {
	return (
		<div className="flex shrink-0 items-center gap-1 border-b border-sidebar-border px-3 py-1.5">
			<span className="text-xs font-medium text-sidebar-foreground/70">Customize sidebar</span>
			<div className="ml-auto flex items-center gap-1">
				{isCustomized ? (
					<Button variant="ghost" size="xs" onClick={onReset}>
						Reset
					</Button>
				) : null}
				<Button size="xs" onClick={onDone}>
					Done
				</Button>
			</div>
		</div>
	)
}
