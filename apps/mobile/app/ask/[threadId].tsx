import { useMemo } from "react"
import { Pressable, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useLocalSearchParams, useRouter } from "expo-router"
import { ChatScreen } from "../../components/chat/chat-screen"
import { decodeAlertContextFromSearchParam } from "../../lib/alert-context"
import { hapticLight } from "../../lib/haptics"

export default function ChatThread() {
	const router = useRouter()
	const insets = useSafeAreaInsets()
	const params = useLocalSearchParams<{ threadId: string; alert?: string }>()
	const threadId = typeof params.threadId === "string" ? decodeURIComponent(params.threadId) : ""

	const alertContext = useMemo(() => {
		if (typeof params.alert !== "string" || !params.alert) return undefined
		return decodeAlertContextFromSearchParam(params.alert)
	}, [params.alert])

	if (!threadId) {
		return <View className="flex-1 bg-background" />
	}

	return (
		<View className="flex-1 bg-background">
			<View className="absolute z-10 flex-row items-center px-4 pt-2" style={{ top: insets.top + 4 }}>
				<Pressable
					onPress={() => {
						hapticLight()
						router.back()
					}}
					hitSlop={12}
					className="flex-row items-center"
				>
					<Text className="font-mono text-[13px] text-primary">← Ask</Text>
				</Pressable>
			</View>
			<ChatScreen threadId={threadId} alertContext={alertContext} topInset={insets.top + 32} />
		</View>
	)
}
