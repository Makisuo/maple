// Minimal markdown renderer for chat text. Block-level: paragraphs, headings
// (h1–h3), bulleted/numbered lists, blockquotes, fenced code, horizontal rules,
// and GFM pipe tables (horizontally scrollable).
// Inline: **bold**, *italic*, `inline code`, [label](url), and bare https URLs.
// Hand-rolled to avoid a markdown dependency; deliberately simple (no nested
// lists, no HTML, no escapes).

import { memo, type ReactNode } from "react"
import { Linking, ScrollView, Text, View } from "react-native"

interface RichTextProps {
	children: string
}

type Alignment = "left" | "center" | "right"

type Block =
	| { kind: "paragraph"; content: string }
	| { kind: "heading"; level: 1 | 2 | 3; content: string }
	| { kind: "code"; language: string | null; content: string }
	| { kind: "quote"; content: string }
	| { kind: "list"; ordered: boolean; items: string[] }
	| { kind: "hr" }
	| { kind: "table"; alignments: Alignment[]; header: string[]; rows: string[][] }

function parsePipeRow(line: string): string[] | null {
	const trimmed = line.trim()
	if (!trimmed.includes("|")) return null
	const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "")
	return inner.split("|").map((c) => c.trim())
}

function parseAlignments(cells: string[]): Alignment[] | null {
	const result: Alignment[] = []
	for (const c of cells) {
		const m = /^(:?)-{3,}(:?)$/.exec(c)
		if (!m) return null
		const left = m[1] === ":"
		const right = m[2] === ":"
		if (left && right) result.push("center")
		else if (right) result.push("right")
		else result.push("left")
	}
	return result
}

function parseBlocks(input: string): Block[] {
	const blocks: Block[] = []
	const lines = input.split("\n")
	let i = 0
	let paragraph: string[] = []

	const flushParagraph = () => {
		if (paragraph.length === 0) return
		const content = paragraph.join("\n").trim()
		if (content) blocks.push({ kind: "paragraph", content })
		paragraph = []
	}

	while (i < lines.length) {
		const line = lines[i]
		const trimmed = line.trim()

		if (!trimmed) {
			flushParagraph()
			i += 1
			continue
		}

		const fence = /^```\s*([\w-]*)\s*$/.exec(trimmed)
		if (fence) {
			flushParagraph()
			const language = fence[1] || null
			const codeLines: string[] = []
			i += 1
			while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
				codeLines.push(lines[i])
				i += 1
			}
			blocks.push({ kind: "code", language, content: codeLines.join("\n") })
			if (i < lines.length) i += 1
			continue
		}

		const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed)
		if (heading) {
			flushParagraph()
			blocks.push({
				kind: "heading",
				level: heading[1].length as 1 | 2 | 3,
				content: heading[2].trim(),
			})
			i += 1
			continue
		}

		if (/^(-{3,}|_{3,}|\*{3,})$/.test(trimmed)) {
			flushParagraph()
			blocks.push({ kind: "hr" })
			i += 1
			continue
		}

		if (trimmed.startsWith(">")) {
			flushParagraph()
			const quoteLines: string[] = []
			while (i < lines.length && lines[i].trim().startsWith(">")) {
				quoteLines.push(lines[i].replace(/^\s*>\s?/, ""))
				i += 1
			}
			blocks.push({ kind: "quote", content: quoteLines.join("\n").trim() })
			continue
		}

		// Pipe table: detect a header row followed by a separator row of dashes.
		const headerCells = parsePipeRow(line)
		if (headerCells && headerCells.length > 0 && i + 1 < lines.length) {
			const sepCells = parsePipeRow(lines[i + 1])
			const alignments = sepCells ? parseAlignments(sepCells) : null
			if (alignments && alignments.length === headerCells.length) {
				flushParagraph()
				const rows: string[][] = []
				i += 2
				while (i < lines.length) {
					const row = parsePipeRow(lines[i])
					if (!row) break
					// Normalize row to header width.
					const normalized = row.slice(0, headerCells.length)
					while (normalized.length < headerCells.length) normalized.push("")
					rows.push(normalized)
					i += 1
				}
				blocks.push({ kind: "table", alignments, header: headerCells, rows })
				continue
			}
		}

		const ul = /^[-*]\s+(.+)$/.exec(trimmed)
		const ol = /^(\d+)\.\s+(.+)$/.exec(trimmed)
		if (ul || ol) {
			flushParagraph()
			const ordered = !!ol
			const items: string[] = []
			while (i < lines.length) {
				const t = lines[i].trim()
				if (!t) break
				const u = /^[-*]\s+(.+)$/.exec(t)
				const o = /^(\d+)\.\s+(.+)$/.exec(t)
				if (ordered && o) items.push(o[2])
				else if (!ordered && u) items.push(u[1])
				else break
				i += 1
			}
			blocks.push({ kind: "list", ordered, items })
			continue
		}

		paragraph.push(line)
		i += 1
	}
	flushParagraph()
	return blocks
}

const INLINE_PATTERN = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+]\([^)]+\)|https?:\/\/[^\s)]+)/g

function renderInline(text: string, keyPrefix = ""): ReactNode[] {
	const out: ReactNode[] = []
	let lastIndex = 0
	let match: RegExpExecArray | null
	let n = 0
	INLINE_PATTERN.lastIndex = 0
	while ((match = INLINE_PATTERN.exec(text)) !== null) {
		if (match.index > lastIndex) {
			out.push(text.slice(lastIndex, match.index))
		}
		const token = match[0]
		const key = `${keyPrefix}-${n++}`
		if (token.startsWith("**")) {
			out.push(
				<Text key={key} className="font-bold text-foreground">
					{token.slice(2, -2)}
				</Text>,
			)
		} else if (token.startsWith("`")) {
			out.push(
				<Text
					key={key}
					className="font-mono text-foreground bg-muted"
					style={{ paddingHorizontal: 4, borderRadius: 3 }}
				>
					{token.slice(1, -1)}
				</Text>,
			)
		} else if (token.startsWith("*")) {
			out.push(
				<Text key={key} style={{ fontStyle: "italic" }}>
					{token.slice(1, -1)}
				</Text>,
			)
		} else if (token.startsWith("[")) {
			const linkMatch = /^\[([^\]]+)]\(([^)]+)\)$/.exec(token)
			if (linkMatch) {
				const [, label, href] = linkMatch
				out.push(
					<Text
						key={key}
						className="text-primary"
						onPress={() => {
							void Linking.openURL(href)
						}}
						style={{ textDecorationLine: "underline" }}
					>
						{label}
					</Text>,
				)
			} else {
				out.push(token)
			}
		} else if (/^https?:\/\//.test(token)) {
			out.push(
				<Text
					key={key}
					className="text-primary"
					onPress={() => {
						void Linking.openURL(token)
					}}
					style={{ textDecorationLine: "underline" }}
				>
					{token}
				</Text>,
			)
		} else {
			out.push(token)
		}
		lastIndex = match.index + token.length
	}
	if (lastIndex < text.length) out.push(text.slice(lastIndex))
	return out
}

function HeadingBlock({
	level,
	content,
	keyPrefix,
}: {
	level: 1 | 2 | 3
	content: string
	keyPrefix: string
}) {
	const size = level === 1 ? 19 : level === 2 ? 16 : 14
	const tracking = level === 3 ? 1 : 0
	const marginTop = level === 1 ? 4 : 2
	return (
		<Text
			className="font-mono font-bold text-foreground"
			style={{ fontSize: size, lineHeight: size + 6, letterSpacing: tracking, marginTop }}
		>
			{renderInline(content, keyPrefix)}
		</Text>
	)
}

function ListBlock({ ordered, items, keyPrefix }: { ordered: boolean; items: string[]; keyPrefix: string }) {
	return (
		<View className="gap-1.5">
			{items.map((item, idx) => (
				<View key={`${keyPrefix}-li-${idx}`} className="flex-row gap-2 pr-2">
					<Text
						className="font-mono text-[14px] leading-[22px] text-muted-foreground"
						style={{ minWidth: ordered ? 22 : 12, textAlign: ordered ? "right" : "left" }}
					>
						{ordered ? `${idx + 1}.` : "•"}
					</Text>
					<Text className="flex-1 font-mono text-[14px] leading-[22px] text-foreground" selectable>
						{renderInline(item, `${keyPrefix}-li-${idx}`)}
					</Text>
				</View>
			))}
		</View>
	)
}

function QuoteBlock({ content, keyPrefix }: { content: string; keyPrefix: string }) {
	const paragraphs = content.split(/\n{2,}/)
	return (
		<View className="flex-row gap-3">
			<View className="bg-border rounded-sm" style={{ width: 2, alignSelf: "stretch" }} />
			<View className="flex-1 gap-2">
				{paragraphs.map((p, idx) => (
					<Text
						key={`${keyPrefix}-q-${idx}`}
						className="font-mono text-[13px] leading-[20px] text-muted-foreground"
						style={{ fontStyle: "italic" }}
						selectable
					>
						{renderInline(p, `${keyPrefix}-q-${idx}`)}
					</Text>
				))}
			</View>
		</View>
	)
}

function TableBlock({
	alignments,
	header,
	rows,
	keyPrefix,
}: {
	alignments: Alignment[]
	header: string[]
	rows: string[][]
	keyPrefix: string
}) {
	const columnWidth = 130
	const renderCell = (
		content: string,
		align: Alignment,
		isLastCol: boolean,
		cellKey: string,
		isHeader: boolean,
	) => (
		<View
			key={cellKey}
			className={isLastCol ? "" : "border-r border-border"}
			style={{
				width: columnWidth,
				paddingHorizontal: 10,
				paddingVertical: 8,
				justifyContent: "center",
			}}
		>
			<Text
				className={`font-mono text-[12px] leading-[18px] ${
					isHeader ? "font-bold text-foreground" : "text-foreground"
				}`}
				selectable
				style={{ textAlign: align }}
			>
				{renderInline(content, cellKey)}
			</Text>
		</View>
	)

	return (
		<View className="rounded-md border border-border overflow-hidden">
			<ScrollView
				horizontal
				showsHorizontalScrollIndicator={false}
				contentContainerStyle={{ flexDirection: "column" }}
			>
				<View>
					<View className="flex-row bg-muted border-b border-border">
						{header.map((h, ci) =>
							renderCell(
								h,
								alignments[ci] ?? "left",
								ci === header.length - 1,
								`${keyPrefix}-th-${ci}`,
								true,
							),
						)}
					</View>
					{rows.map((row, ri) => {
						const isLastRow = ri === rows.length - 1
						return (
							<View
								key={`${keyPrefix}-tr-${ri}`}
								className={`flex-row ${isLastRow ? "" : "border-b border-border"}`}
							>
								{row.map((cell, ci) =>
									renderCell(
										cell,
										alignments[ci] ?? "left",
										ci === row.length - 1,
										`${keyPrefix}-td-${ri}-${ci}`,
										false,
									),
								)}
							</View>
						)
					})}
				</View>
			</ScrollView>
		</View>
	)
}

function CodeBlock({ language, content }: { language: string | null; content: string }) {
	return (
		<View className="rounded-md border border-border bg-muted px-3 py-2">
			{language ? (
				<Text
					className="mb-1 font-mono text-[10px] uppercase text-muted-foreground"
					style={{ letterSpacing: 1.5 }}
				>
					{language}
				</Text>
			) : null}
			<Text className="font-mono text-[13px] leading-[18px] text-foreground" selectable>
				{content}
			</Text>
		</View>
	)
}

function RichTextImpl({ children }: RichTextProps) {
	const blocks = parseBlocks(children)
	return (
		<View className="gap-3">
			{blocks.map((block, idx) => {
				const keyPrefix = `b${idx}`
				switch (block.kind) {
					case "paragraph":
						return (
							<Text
								key={keyPrefix}
								className="font-mono text-[14px] leading-[22px] text-foreground"
								selectable
							>
								{renderInline(block.content, keyPrefix)}
							</Text>
						)
					case "heading":
						return (
							<HeadingBlock
								key={keyPrefix}
								level={block.level}
								content={block.content}
								keyPrefix={keyPrefix}
							/>
						)
					case "list":
						return (
							<ListBlock
								key={keyPrefix}
								ordered={block.ordered}
								items={block.items}
								keyPrefix={keyPrefix}
							/>
						)
					case "code":
						return <CodeBlock key={keyPrefix} language={block.language} content={block.content} />
					case "quote":
						return <QuoteBlock key={keyPrefix} content={block.content} keyPrefix={keyPrefix} />
					case "table":
						return (
							<TableBlock
								key={keyPrefix}
								alignments={block.alignments}
								header={block.header}
								rows={block.rows}
								keyPrefix={keyPrefix}
							/>
						)
					case "hr":
						return <View key={keyPrefix} className="bg-border my-1" style={{ height: 1 }} />
				}
			})}
		</View>
	)
}

export const RichText = memo(RichTextImpl)
