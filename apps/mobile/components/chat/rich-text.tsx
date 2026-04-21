// Minimal markdown-ish renderer for chat text. Supports:
//   **bold**, *italic*, `inline code`, ```fenced code``` (as a block), and [link](url).
// Hand-rolled to avoid pulling in a markdown library.

import { memo, type ReactNode } from "react"
import { Linking, Text, View } from "react-native"

interface RichTextProps {
	children: string
	className?: string
}

type Block =
	| { kind: "paragraph"; content: string }
	| { kind: "code"; language: string | null; content: string }

function splitBlocks(input: string): Block[] {
	const blocks: Block[] = []
	const lines = input.split("\n")
	let i = 0
	let paragraph: string[] = []

	const flush = () => {
		if (paragraph.length === 0) return
		blocks.push({ kind: "paragraph", content: paragraph.join("\n").trim() })
		paragraph = []
	}

	while (i < lines.length) {
		const line = lines[i]
		const fence = /^```\s*([\w-]*)\s*$/.exec(line)
		if (fence) {
			flush()
			const language = fence[1] || null
			const codeLines: string[] = []
			i += 1
			while (i < lines.length && !/^```\s*$/.test(lines[i])) {
				codeLines.push(lines[i])
				i += 1
			}
			blocks.push({ kind: "code", language, content: codeLines.join("\n") })
			if (i < lines.length) i += 1
			continue
		}
		paragraph.push(line)
		i += 1
	}
	flush()
	return blocks
}

function renderInline(text: string): ReactNode[] {
	const out: ReactNode[] = []
	const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+]\([^)]+\))/g
	let lastIndex = 0
	let m: RegExpExecArray | null
	let key = 0
	while ((m = pattern.exec(text)) !== null) {
		if (m.index > lastIndex) {
			out.push(text.slice(lastIndex, m.index))
		}
		const token = m[0]
		if (token.startsWith("**")) {
			out.push(
				<Text key={`b-${key++}`} className="font-bold text-foreground">
					{token.slice(2, -2)}
				</Text>,
			)
		} else if (token.startsWith("`")) {
			out.push(
				<Text
					key={`c-${key++}`}
					className="font-mono text-foreground bg-muted"
					style={{ paddingHorizontal: 4, borderRadius: 3 }}
				>
					{token.slice(1, -1)}
				</Text>,
			)
		} else if (token.startsWith("*")) {
			out.push(
				<Text key={`i-${key++}`} style={{ fontStyle: "italic" }}>
					{token.slice(1, -1)}
				</Text>,
			)
		} else if (token.startsWith("[")) {
			const linkMatch = /^\[([^\]]+)]\(([^)]+)\)$/.exec(token)
			if (linkMatch) {
				const [, label, href] = linkMatch
				out.push(
					<Text
						key={`l-${key++}`}
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
		} else {
			out.push(token)
		}
		lastIndex = m.index + token.length
	}
	if (lastIndex < text.length) out.push(text.slice(lastIndex))
	return out
}

function RichTextImpl({ children }: RichTextProps) {
	const blocks = splitBlocks(children)
	return (
		<View className="gap-3">
			{blocks.map((block, idx) => {
				if (block.kind === "code") {
					return (
						<View
							key={`cb-${idx}`}
							className="rounded-md border border-border bg-muted px-3 py-2"
						>
							{block.language ? (
								<Text
									className="font-mono text-[10px] uppercase text-muted-foreground mb-1"
									style={{ letterSpacing: 1.5 }}
								>
									{block.language}
								</Text>
							) : null}
							<Text className="font-mono text-[13px] text-foreground" selectable>
								{block.content}
							</Text>
						</View>
					)
				}
				return (
					<Text
						key={`p-${idx}`}
						className="font-mono text-[14px] leading-[22px] text-foreground"
						selectable
					>
						{renderInline(block.content)}
					</Text>
				)
			})}
		</View>
	)
}

export const RichText = memo(RichTextImpl)
