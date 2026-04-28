import { useEffect, useRef } from "react"
import { View } from "react-native"
import { LegendList, type LegendListRef } from "@legendapp/list"
import type { UIMessage } from "ai"
import { MessageBubble } from "./message-bubble"
import { ThinkingIndicator } from "./thinking-indicator"

interface MessageListProps {
	messages: UIMessage[]
	isStreaming: boolean
}

type Row = { kind: "msg"; message: UIMessage; isLast: boolean } | { kind: "thinking" }

export function MessageList({ messages, isStreaming }: MessageListProps) {
	const ref = useRef<LegendListRef>(null)

	const last = messages[messages.length - 1]
	const showBareThinking = isStreaming && (last === undefined || last.role === "user")

	const rows: Row[] = messages.map((message, i) => ({
		kind: "msg" as const,
		message,
		isLast: i === messages.length - 1,
	}))
	if (showBareThinking) rows.push({ kind: "thinking" })

	useEffect(() => {
		const id = setTimeout(() => {
			try {
				ref.current?.scrollToEnd({ animated: true })
			} catch {
				// LegendListRef may not expose scrollToEnd in all versions — noop.
			}
		}, 20)
		return () => clearTimeout(id)
	}, [rows.length, isStreaming])

	return (
		<LegendList
			ref={ref}
			data={rows}
			keyExtractor={(row, i) => (row.kind === "msg" ? row.message.id : `thinking-${i}`)}
			contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 16, gap: 4 }}
			estimatedItemSize={120}
			recycleItems={false}
			maintainScrollAtEnd
			alignItemsAtEnd
			renderItem={({ item }) => {
				if (item.kind === "thinking") {
					return (
						<View className="flex-row gap-3 pr-2 py-1">
							<View
								className="bg-primary rounded-sm"
								style={{ width: 2, opacity: 0.6, alignSelf: "stretch" }}
							/>
							<ThinkingIndicator />
						</View>
					)
				}
				return <MessageBubble message={item.message} isStreaming={isStreaming} isLast={item.isLast} />
			}}
		/>
	)
}
