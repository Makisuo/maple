import { useMemo, useRef, useState } from "react"
import { cn } from "@maple/ui/utils"
import { formatOffsetLabel, getOffsetMinutes } from "@maple/ui/lib/time-format"
import { ChevronExpandYIcon, MagnifierIcon } from "@/components/icons"
import { getBrowserTimeZone, SYSTEM_VALUE } from "@/atoms/timezone-preference-atoms"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"

interface TzOption {
	/** IANA id or `SYSTEM_VALUE`. */
	value: string
	/** "(UTC+02:00)" — the left offset column. */
	offsetLabel: string
	/** Primary label ("Europe/Berlin", "System", "UTC"). */
	name: string
	/** Optional muted trailing hint (the browser zone behind "System"). */
	hint?: string
	/** Lowercase search string: city, IANA id, and offset synonyms. */
	keywords: string
	/** Signed minutes from UTC (sort key). */
	offsetMinutes: number
}

/** Offset search synonyms: "+2", "utc+2", "gmt+2", "+02:00" (+ "+5:30"/"+05:30" for half-hour zones). */
function offsetSynonyms(minutes: number): string {
	const sign = minutes < 0 ? "-" : "+"
	const abs = Math.abs(minutes)
	const h = Math.floor(abs / 60)
	const m = abs % 60
	const hh = h.toString().padStart(2, "0")
	const mm = m.toString().padStart(2, "0")

	const forms = new Set<string>([`${sign}${h}`, `${sign}${hh}:${mm}`])
	if (m !== 0) forms.add(`${sign}${h}:${mm}`)

	const out: string[] = []
	for (const form of forms) {
		out.push(form, `utc${form}`, `gmt${form}`)
	}
	return out.join(" ")
}

/** IANA id + its city segment (underscores → spaces) for search-by-city. */
function cityKeywords(iana: string): string {
	const segments = iana.toLowerCase().split("/")
	const city = (segments[segments.length - 1] ?? "").replace(/_/g, " ")
	return `${iana.toLowerCase()} ${city}`
}

/**
 * Global timezone selector for the time range picker footer. A quiet trigger
 * strip shows the current effective zone; clicking it expands an inline,
 * searchable list (city "berlin", IANA id, or offset "+2"/"utc+2"/"+05:30").
 *
 * The list is a plain controlled input + `<button>` rows rendered *inline*
 * inside the picker — deliberately not a base-ui popup/combobox: a nested
 * floating layer (or base-ui's own item pointer handling) is swallowed by the
 * parent time picker `Popover`'s outside-press/focus management, so item clicks
 * never commit. Plain buttons inside the popover fire reliably.
 *
 * The full ~420-zone list is sorted by current offset (recomputed each time the
 * panel opens, since offsets are DST-dependent) with "System" and "UTC" pinned
 * on top. Selection writes through the global preference atom.
 */
export function TimezoneCombobox({ className }: { className?: string }) {
	const { supportedTimezones, selectedTimezone, setSelectedTimezone, effectiveTimezone } =
		useTimezonePreference()
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState("")
	const [highlight, setHighlight] = useState(0)
	const triggerRef = useRef<HTMLButtonElement | null>(null)

	const options = useMemo(() => {
		const now = new Date()
		const browserZone = getBrowserTimeZone()

		const zones: TzOption[] = supportedTimezones
			.filter((iana) => iana !== "UTC")
			.map((iana) => {
				const offsetMinutes = getOffsetMinutes(iana, now)
				return {
					value: iana,
					offsetLabel: formatOffsetLabel(iana, now),
					name: iana,
					keywords: `${cityKeywords(iana)} ${offsetSynonyms(offsetMinutes)}`,
					offsetMinutes,
				}
			})
			.sort((a, b) => a.offsetMinutes - b.offsetMinutes || a.name.localeCompare(b.name))

		const systemOffset = getOffsetMinutes(browserZone, now)
		const system: TzOption = {
			value: SYSTEM_VALUE,
			offsetLabel: formatOffsetLabel(browserZone, now),
			name: "System",
			hint: browserZone,
			keywords: `system ${cityKeywords(browserZone)} ${offsetSynonyms(systemOffset)}`,
			offsetMinutes: systemOffset,
		}
		const utc: TzOption = {
			value: "UTC",
			offsetLabel: "(UTC+00:00)",
			name: "UTC",
			keywords: `utc coordinated universal time ${offsetSynonyms(0)}`,
			offsetMinutes: 0,
		}

		return [system, utc, ...zones]
		// Recompute when the panel opens (DST-dependent offsets) or the list changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, supportedTimezones])

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase()
		if (!q) return options
		return options.filter((option) => option.keywords.includes(q))
	}, [options, query])

	const currentValue = selectedTimezone ?? SYSTEM_VALUE

	const triggerLabel =
		selectedTimezone === null
			? `System · ${effectiveTimezone}`
			: `${formatOffsetLabel(effectiveTimezone).replace(/[()]/g, "")} · ${effectiveTimezone}`

	const handleSelect = (value: string) => {
		setSelectedTimezone(value === SYSTEM_VALUE ? null : value)
		setQuery("")
		setOpen(false)
		// Return focus to the trigger so collapsing the panel (which unmounts the
		// focused search input) doesn't bubble focus out of the parent picker
		// Popover and dismiss the whole thing.
		triggerRef.current?.focus()
	}

	const toggle = () => {
		setQuery("")
		setHighlight(0)
		setOpen((prev) => !prev)
	}

	const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown") {
			event.preventDefault()
			setHighlight((index) => Math.min(index + 1, filtered.length - 1))
		} else if (event.key === "ArrowUp") {
			event.preventDefault()
			setHighlight((index) => Math.max(index - 1, 0))
		} else if (event.key === "Enter") {
			event.preventDefault()
			const option = filtered[highlight]
			if (option) handleSelect(option.value)
		} else if (event.key === "Escape") {
			event.preventDefault()
			setOpen(false)
		}
	}

	return (
		<div className={cn("border-t border-border/70 bg-muted/20", className)}>
			<button
				ref={triggerRef}
				type="button"
				aria-expanded={open}
				onClick={toggle}
				className="group flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left outline-none transition-colors hover:bg-muted/30 focus-visible:bg-muted/40"
			>
				<span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/80">
					Timezone
				</span>
				<span className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] tracking-tight text-foreground/85">
					<span className="truncate">{triggerLabel}</span>
					<ChevronExpandYIcon className="size-3 shrink-0 text-muted-foreground/70 transition-colors group-hover:text-muted-foreground" />
				</span>
			</button>

			{open && (
				<div className="border-t border-border/60">
					<div className="flex h-9 items-center gap-2 border-b border-border/60 px-3">
						<MagnifierIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
						<input
							autoFocus
							value={query}
							onChange={(event) => {
								setQuery(event.target.value)
								setHighlight(0)
							}}
							onKeyDown={onSearchKeyDown}
							placeholder="Search city or offset (e.g. berlin, +2)…"
							spellCheck={false}
							autoComplete="off"
							role="combobox"
							aria-expanded="true"
							aria-controls="timezone-listbox"
							className="h-full flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
						/>
					</div>
					<div
						id="timezone-listbox"
						role="listbox"
						className="max-h-64 overflow-y-auto overscroll-contain p-1"
					>
						{filtered.length === 0 ? (
							<div className="px-2 py-3 text-center text-muted-foreground text-sm">
								No timezones found.
							</div>
						) : (
							filtered.map((option, index) => (
								<button
									key={option.value}
									type="button"
									role="option"
									aria-selected={option.value === currentValue}
									onClick={() => handleSelect(option.value)}
									onMouseMove={() => setHighlight(index)}
									className={cn(
										"flex w-full items-center gap-2.5 rounded-sm px-2 py-1 text-left text-xs outline-none",
										index === highlight
											? "bg-accent text-accent-foreground"
											: "text-foreground",
									)}
								>
									<span className="w-[72px] shrink-0 font-mono text-[11px] text-muted-foreground">
										{option.offsetLabel}
									</span>
									<span className={cn("truncate", option.value === currentValue && "font-medium")}>
										{option.name}
									</span>
									{option.hint && (
										<span className="ml-auto truncate pl-3 font-mono text-[10px] text-muted-foreground/70">
											{option.hint}
										</span>
									)}
									{option.value === currentValue && !option.hint && (
										<span
											aria-hidden="true"
											className="ml-auto size-1.5 shrink-0 rounded-full bg-primary/70"
										/>
									)}
								</button>
							))
						)}
					</div>
				</div>
			)}
		</div>
	)
}
