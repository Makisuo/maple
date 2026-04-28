import { useMemo } from "react"
import { KeyboardAvoidingView, Platform, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useMobileChat } from "../../hooks/use-mobile-chat"
import { alertPromptSuggestions, type AlertContext } from "../../lib/alert-context"
import { AlertBanner } from "./alert-banner"
import { Composer } from "./composer"
import { EmptyState } from "./empty-state"
import { MessageList } from "./message-list"
import { SuggestionChips } from "./suggestion-chips"

interface ChatScreenProps {
	threadId: string
	alertContext?: AlertContext
	topInset: number
}

const DEFAULT_SUGGESTIONS = [
	"What's the overall system health?",
	"Show me the slowest traces",
	"Are there any errors right now?",
	"Which services have the highest error rate?",
]

export function ChatScreen({ threadId, alertContext, topInset }: ChatScreenProps) {
	const insets = useSafeAreaInsets()
	const { messages, status, error, hydrated, sendMessage, stop } = useMobileChat({
		threadId,
		alertContext,
	})

	const isAlertMode = !!alertContext
	const suggestions = useMemo(
		() => (isAlertMode ? alertPromptSuggestions(alertContext!) : DEFAULT_SUGGESTIONS),
		[isAlertMode, alertContext],
	)

	const isStreaming = status === "streaming" || status === "submitted"

	return (
		<KeyboardAvoidingView
			className="flex-1 bg-background"
			behavior={Platform.OS === "ios" ? "padding" : undefined}
			keyboardVerticalOffset={topInset + 40}
			style={{ paddingTop: topInset }}
		>
			{alertContext ? <AlertBanner alert={alertContext} /> : null}

			{!hydrated ? (
				<View className="flex-1" />
			) : messages.length === 0 ? (
				<EmptyState
					tagline={
						isAlertMode
							? "The alert is attached to this thread. Ask anything to investigate."
							: undefined
					}
				/>
			) : (
				<MessageList messages={messages} isStreaming={isStreaming} />
			)}

			{error ? (
				<View className="mx-4 mb-2 rounded-md bg-destructive/10 px-3 py-2">
					<Text className="font-mono text-[11px] text-destructive" numberOfLines={3}>
						{error}
					</Text>
				</View>
			) : null}

			<View className="pb-2 gap-2" style={{ marginBottom: insets.bottom > 0 ? 0 : 4 }}>
				{suggestions.length > 0 ? (
					<SuggestionChips suggestions={suggestions} onPick={sendMessage} />
				) : null}
				<Composer
					onSend={sendMessage}
					onStop={stop}
					isStreaming={isStreaming}
					placeholder={isAlertMode ? "Ask about this alert…" : "Ask about your system…"}
				/>
			</View>
		</KeyboardAvoidingView>
	)
}
