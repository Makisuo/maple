import { memo } from "react"
import { Text, View } from "react-native"
import type { UIMessage } from "ai"
import { RichText } from "./rich-text"
import { ToolCallCard } from "./tool-call-card"
import { ThinkingIndicator } from "./thinking-indicator"

interface MessageBubbleProps {
	message: UIMessage
	isStreaming: boolean
	isLast: boolean
}

type ToolPartShape = {
	type: string
	toolCallId: string
	toolName?: string
	state: "input-streaming" | "input-available" | "output-available" | "output-error"
	input?: unknown
	output?: unknown
	errorText?: string
}

function shouldShowThinking(message: UIMessage, isStreaming: boolean, isLast: boolean): boolean {
	if (!isStreaming || !isLast || message.role !== "assistant") return false
	if (message.parts.length === 0) return true
	const last = message.parts[message.parts.length - 1] as { type: string; text?: string }
	if (last.type === "text" && typeof last.text === "string" && last.text.length > 0) return false
	return true
}

function MessageBubbleImpl({ message, isStreaming, isLast }: MessageBubbleProps) {
	const isUser = message.role === "user"

	if (isUser) {
		const text = message.parts
			.filter((p) => p.type === "text")
			.map((p) => (p as { text?: string }).text ?? "")
			.join("")
		return (
			<View className="items-end w-full py-1">
				<View
					className="rounded-xl border border-border bg-card px-3.5 py-2.5"
					style={{ maxWidth: "78%" }}
				>
					<Text className="font-mono text-[14px] leading-[22px] text-foreground" selectable>
						{text}
					</Text>
				</View>
			</View>
		)
	}

	return (
		<View className="flex-row gap-3 py-1 pr-2">
			<View
				className="bg-primary rounded-sm"
				style={{ width: 2, opacity: 0.6, alignSelf: "stretch" }}
			/>
			<View className="flex-1 gap-3">
				{message.parts.map((part, i) => {
					if (part.type === "text") {
						const text = (part as { text?: string }).text ?? ""
						if (!text) return null
						return <RichText key={`t-${i}`}>{text}</RichText>
					}
					if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
						const tool = part as unknown as ToolPartShape
						const name = part.type.startsWith("tool-")
							? part.type.replace(/^tool-/, "")
							: (tool.toolName ?? "tool")
						return (
							<ToolCallCard
								key={tool.toolCallId ?? `tool-${i}`}
								toolName={name}
								state={tool.state ?? "input-streaming"}
								input={tool.input}
								output={tool.output}
								errorText={tool.errorText}
							/>
						)
					}
					return null
				})}
				{shouldShowThinking(message, isStreaming, isLast) ? <ThinkingIndicator /> : null}
			</View>
		</View>
	)
}

export const MessageBubble = memo(MessageBubbleImpl)
