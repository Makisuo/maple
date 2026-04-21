import { Pressable, Text, View } from "react-native"
import { useRouter } from "expo-router"
import { Screen } from "../../components/ui/screen"
import { ScreenHeader } from "../../components/ui/screen-header"
import { ThreadList } from "../../components/chat/thread-list"
import { EmptyState } from "../../components/chat/empty-state"
import { useChatThreads } from "../../hooks/use-chat-threads"
import { hapticLight, hapticMedium } from "../../lib/haptics"
import { SparklesIcon } from "../../components/icons/sparkles-icon"

export default function AskIndex() {
	const router = useRouter()
	const { threads, loaded } = useChatThreads()

	const goNew = () => {
		hapticMedium()
		router.push("/ask/new")
	}

	const goBack = () => {
		hapticLight()
		if (router.canGoBack()) router.back()
		else router.replace("/")
	}

	return (
		<Screen>
			<ScreenHeader
				title="Ask"
				subtitle="Investigate with Maple AI"
				backLabel="Overview"
				onBack={goBack}
				right={
					<Pressable
						onPress={goNew}
						className="flex-row items-center gap-1.5 rounded-full bg-primary px-3 py-1.5"
					>
						<SparklesIcon size={12} />
						<Text
							className="font-mono text-[11px] font-bold text-primary-foreground"
							style={{ letterSpacing: 0.5 }}
						>
							NEW
						</Text>
					</Pressable>
				}
			/>
			{!loaded ? (
				<View className="flex-1" />
			) : threads.length === 0 ? (
				<View className="flex-1">
					<EmptyState tagline="No conversations yet. Start one with the NEW button above." />
				</View>
			) : (
				<ThreadList threads={threads} />
			)}
		</Screen>
	)
}
