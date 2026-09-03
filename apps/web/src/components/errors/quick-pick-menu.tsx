import {
	useRef,
	useState,
	type KeyboardEvent,
	type ReactElement,
	type ReactNode,
	type RefObject,
} from "react"

import { AutocompletePrimitive } from "@maple/ui/components/ui/autocomplete"
import { CommandCollection, CommandEmpty, CommandItem, CommandList } from "@maple/ui/components/ui/command"
import { Kbd } from "@maple/ui/components/ui/kbd"
import { Popover, PopoverPrimitive, PopoverTrigger } from "@maple/ui/components/ui/popover"
import { cn } from "@maple/ui/lib/utils"

import { CheckIcon } from "@/components/icons"

/**
 * A Linear-style inline picker: a small popover with a type-to-filter input on
 * top, a hotkey hint beside it, and one row per choice with its icon, a check
 * on the current value and a digit that picks it outright.
 *
 * Built on Popover + the inline Autocomplete that backs the command palette
 * rather than on Menu, because a menu cannot be typed into and the whole point
 * of the input is that "in r⏎" beats scanning nine rows.
 */

export interface QuickPickItem<V extends string> {
	readonly value: V
	readonly label: string
	readonly icon: ReactNode
	/** Digit shown at the row's right edge; pressing it with an empty query picks the row. */
	readonly shortcut?: string
	readonly disabled?: boolean
	/** Extra words the filter matches on, beyond the label. */
	readonly keywords?: string
}

export interface QuickPickMenuProps<V extends string> {
	items: ReadonlyArray<QuickPickItem<V>>
	current: V | null
	onSelect: (value: V) => void
	/** Placeholder of the filter input — "Change status…". */
	placeholder: string
	/** The key that opens this picker from a focused row, shown beside the input. */
	hotkey?: string
	open?: boolean
	onOpenChange?: (open: boolean) => void
	disabled?: boolean
	/**
	 * Where to hang the popover when the trigger itself is not on screen — a
	 * responsive lane hides the trigger below some width, but the row's hotkey
	 * still has to open something, and a popover anchored to a `display: none`
	 * element lands in the page's top-left corner.
	 */
	fallbackAnchor?: RefObject<HTMLElement | null>
	/** The trigger. Rendered through Base UI's `render`, so it keeps its own markup. */
	children: ReactElement
	/** Accessible name for the listbox. */
	label: string
}

const isOnScreen = (element: HTMLElement | null): element is HTMLElement =>
	element !== null && element.getClientRects().length > 0

export function QuickPickMenu<V extends string>({
	items,
	current,
	onSelect,
	placeholder,
	hotkey,
	open: openProp,
	onOpenChange,
	disabled,
	fallbackAnchor,
	children,
	label,
}: QuickPickMenuProps<V>) {
	const [openState, setOpenState] = useState(false)
	const open = openProp ?? openState
	const setOpen = (next: boolean) => {
		setOpenState(next)
		onOpenChange?.(next)
	}
	const triggerRef = useRef<HTMLButtonElement | null>(null)

	const pick = (value: V) => {
		setOpen(false)
		if (value !== current) onSelect(value)
	}

	// Digits pick a row directly, Linear-style — but only while nothing has been
	// typed, so a query that happens to contain a digit still filters.
	const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.currentTarget.value !== "" || !/^[0-9]$/.test(event.key)) return
		const item = items.find((candidate) => candidate.shortcut === event.key && !candidate.disabled)
		if (item === undefined) return
		event.preventDefault()
		pick(item.value)
	}

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				ref={triggerRef}
				render={children}
				disabled={disabled}
				// The trigger sits inside the row's link. Stop the click there so the
				// row does not navigate, and keep it from the anchor's default action.
				onClick={(event) => {
					event.preventDefault()
					event.stopPropagation()
				}}
			/>
			<PopoverPrimitive.Portal>
				<PopoverPrimitive.Positioner
					side="bottom"
					align="start"
					sideOffset={6}
					className="isolate z-55 outline-none"
					anchor={() =>
						isOnScreen(triggerRef.current)
							? triggerRef.current
							: (fallbackAnchor?.current ?? null)
					}
				>
					<PopoverPrimitive.Popup
						className={cn(
							"w-60 origin-(--transform-origin) overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none",
							"duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
						)}
						// Portalled, but React events still bubble to the row's link. Nothing
						// clicked in here should open the issue.
						onClick={(event) => event.stopPropagation()}
						onKeyDownCapture={(event) => {
							// The forced-open Autocomplete swallows Escape before the popover
							// sees it, the same trap the command palette works around.
							if (event.key === "Escape") {
								event.preventDefault()
								event.stopPropagation()
								setOpen(false)
							}
						}}
					>
						{/* The primitive rather than the `Command` wrapper: the wrapper erases
						    the item generic, and the filter needs it. Same settings — inline,
						    always open, first row highlighted. */}
						<AutocompletePrimitive.Root
							items={items}
							inline
							open
							autoHighlight="always"
							keepHighlight
							filter={(item, query) =>
								`${item.label} ${item.keywords ?? ""}`
									.toLowerCase()
									.includes(query.trim().toLowerCase())
							}
						>
							<div className="flex items-center gap-2 border-b border-border/60 px-3">
								<AutocompletePrimitive.Input
									autoFocus
									aria-label={label}
									placeholder={placeholder}
									onKeyDown={onInputKeyDown}
									className="h-9 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
								/>
								{hotkey ? <Kbd className="h-4.5 min-w-4.5 text-[10px]">{hotkey}</Kbd> : null}
							</div>
							<CommandList className="not-empty:p-1">
								<CommandEmpty className="not-empty:py-4 text-xs">No match</CommandEmpty>
								<CommandCollection>
									{(item: QuickPickItem<V>) => (
										<CommandItem
											key={item.value}
											value={item}
											disabled={item.disabled}
											onClick={() => pick(item.value)}
											className="gap-2 rounded-md px-2 py-1.5 text-xs text-foreground data-disabled:opacity-40"
										>
											<span className="flex size-4 shrink-0 items-center justify-center">
												{item.icon}
											</span>
											<span className="min-w-0 flex-1 truncate">{item.label}</span>
											{item.value === current ? (
												<CheckIcon size={12} className="shrink-0 text-foreground" />
											) : null}
											{item.shortcut ? (
												<span className="w-3 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground/70">
													{item.shortcut}
												</span>
											) : null}
										</CommandItem>
									)}
								</CommandCollection>
							</CommandList>
						</AutocompletePrimitive.Root>
					</PopoverPrimitive.Popup>
				</PopoverPrimitive.Positioner>
			</PopoverPrimitive.Portal>
		</Popover>
	)
}
