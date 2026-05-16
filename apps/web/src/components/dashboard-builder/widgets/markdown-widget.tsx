import { memo } from "react"

import { WidgetShell } from "@/components/dashboard-builder/widgets/widget-shell"
import type { WidgetDataState, WidgetDisplayConfig, WidgetMode } from "@/components/dashboard-builder/types"
import { validateUrlScheme } from "@maple/ui/lib/sanitizers"

interface MarkdownWidgetProps {
	dataState?: WidgetDataState
	display: WidgetDisplayConfig
	mode: WidgetMode
	onRemove?: () => void
	onClone?: () => void
	onConfigure?: () => void
	onFix?: () => void
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/
const LIST_RE = /^[-*]\s+(.*)$/
const ORDERED_LIST_RE = /^\d+\.\s+(.*)$/

function renderInline(text: string): React.ReactNode[] {
	const tokens: React.ReactNode[] = []
	let cursor = 0
	const pattern = /(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(`[^`]+`)/g
	let match: RegExpExecArray | null
	let key = 0
	while ((match = pattern.exec(text)) !== null) {
		if (match.index > cursor) {
			tokens.push(text.slice(cursor, match.index))
		}
		const segment = match[0]
		if (segment.startsWith("[")) {
			const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(segment)
			if (linkMatch) {
				const safeHref = validateUrlScheme(linkMatch[2])
				if (safeHref) {
					tokens.push(
						<a
							key={`l-${key++}`}
							href={safeHref}
							target="_blank"
							rel="noreferrer"
							className="text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary"
						>
							{linkMatch[1]}
						</a>,
					)
				} else {
					// Reject `javascript:` / `data:` / protocol-relative — render as
					// plain text so an attacker can't smuggle a clickable XSS link
					// through a stored markdown widget.
					tokens.push(
						<span
							key={`l-${key++}`}
							title={`Blocked unsupported link scheme: ${linkMatch[2]}`}
							className="text-muted-foreground"
						>
							{linkMatch[1]}
						</span>,
					)
				}
			}
		} else if (segment.startsWith("**")) {
			tokens.push(<strong key={`b-${key++}`}>{segment.slice(2, -2)}</strong>)
		} else if (segment.startsWith("*")) {
			tokens.push(<em key={`i-${key++}`}>{segment.slice(1, -1)}</em>)
		} else if (segment.startsWith("`")) {
			tokens.push(
				<code key={`c-${key++}`} className="px-1 py-0.5 rounded bg-muted text-[0.85em] font-mono">
					{segment.slice(1, -1)}
				</code>,
			)
		}
		cursor = pattern.lastIndex
	}
	if (cursor < text.length) {
		tokens.push(text.slice(cursor))
	}
	return tokens
}

function renderMarkdown(content: string): React.ReactNode {
	const lines = content.split(/\r?\n/)
	const blocks: React.ReactNode[] = []
	let paragraph: string[] = []
	let listItems: string[] | null = null
	let orderedList: boolean = false

	const flushParagraph = () => {
		if (paragraph.length > 0) {
			blocks.push(
				<p key={`p-${blocks.length}`} className="leading-relaxed">
					{renderInline(paragraph.join(" "))}
				</p>,
			)
			paragraph = []
		}
	}

	const flushList = () => {
		if (listItems && listItems.length > 0) {
			const Tag = orderedList ? "ol" : "ul"
			blocks.push(
				<Tag
					key={`list-${blocks.length}`}
					className={`pl-5 ${orderedList ? "list-decimal" : "list-disc"} space-y-0.5`}
				>
					{listItems.map((item, i) => (
						<li key={i}>{renderInline(item)}</li>
					))}
				</Tag>,
			)
			listItems = null
		}
	}

	for (const rawLine of lines) {
		const line = rawLine.trim()
		if (line === "") {
			flushParagraph()
			flushList()
			continue
		}

		const headingMatch = HEADING_RE.exec(line)
		if (headingMatch) {
			flushParagraph()
			flushList()
			const level = headingMatch[1].length
			const sizes = ["text-lg", "text-base", "text-sm", "text-sm", "text-xs", "text-xs"]
			const weight = level <= 2 ? "font-semibold" : "font-medium"
			blocks.push(
				<div key={`h-${blocks.length}`} className={`${sizes[level - 1]} ${weight} mt-2 first:mt-0`}>
					{renderInline(headingMatch[2])}
				</div>,
			)
			continue
		}

		const listMatch = LIST_RE.exec(line)
		const orderedMatch = ORDERED_LIST_RE.exec(line)
		if (listMatch || orderedMatch) {
			flushParagraph()
			const isOrdered = !!orderedMatch
			if (listItems === null || orderedList !== isOrdered) {
				flushList()
				listItems = []
				orderedList = isOrdered
			}
			listItems.push((listMatch ?? orderedMatch)![1])
			continue
		}

		paragraph.push(line)
	}

	flushParagraph()
	flushList()

	return blocks
}

export const MarkdownWidget = memo(function MarkdownWidget({
	display,
	mode,
	onRemove,
	onClone,
	onConfigure,
}: MarkdownWidgetProps) {
	const content = display.markdown?.content ?? ""

	return (
		<WidgetShell
			title={display.title || "Note"}
			mode={mode}
			onRemove={onRemove}
			onClone={onClone}
			onConfigure={onConfigure}
			contentClassName="flex-1 min-h-0 overflow-auto p-3"
		>
			{content.trim() === "" ? (
				<div className="text-xs text-muted-foreground italic">
					Empty note. Edit to add markdown content.
				</div>
			) : (
				<div className="text-xs text-foreground space-y-2">{renderMarkdown(content)}</div>
			)}
		</WidgetShell>
	)
})
