import { Pressable, Text, View } from "react-native"
import { LegendList } from "@legendapp/list"
import { useRouter } from "expo-router"
import { type ThreadSummary } from "../../lib/chat-threads"
import { useScreenBottomPadding } from "../ui/screen"
import { hapticLight } from "../../lib/haptics"

function formatRelative(ts: number): string {
	const diff = Date.now() - ts
	const m = Math.floor(diff / 60_000)
	if (m < 1) return "just now"
	if (m < 60) return `${m}m`
	const h = Math.floor(m / 60)
	if (h < 24) return `${h}h`
	const d = Math.floor(h / 24)
	if (d < 30) return `${d}d`
	return new Date(ts).toLocaleDateString()
}

interface ThreadRowProps {
	thread: ThreadSummary
}

function ThreadRow({ thread: t }: ThreadRowProps) {
	const router = useRouter()
	return (
		<Pressable
			onPress={() => {
				hapticLight()
				router.push(`/ask/${encodeURIComponent(t.threadId)}`)
			}}
			className="flex-row items-start gap-3 px-4 py-3.5"
		>
			<View
				className={`rounded-sm ${t.alertContext ? "bg-destructive" : "bg-muted"}`}
				style={{ width: 3, alignSelf: "stretch" }}
			/>
			<View className="flex-1 gap-1">
				<View className="flex-row items-baseline gap-2">
					<Text
						className="flex-1 font-mono text-[13px] font-bold text-foreground"
						numberOfLines={1}
					>
						{t.title}
					</Text>
					<Text className="font-mono text-[10px] text-muted-foreground">
						{formatRelative(t.lastMessageAt)}
					</Text>
				</View>
				{t.lastMessagePreview ? (
					<Text className="font-mono text-[12px] text-muted-foreground" numberOfLines={2}>
						{t.lastMessagePreview}
					</Text>
				) : null}
				{t.alertContext ? (
					<Text className="font-mono text-[10px] text-destructive" style={{ letterSpacing: 1.2 }}>
						ALERT · {t.alertContext.ruleName.slice(0, 40)}
					</Text>
				) : null}
			</View>
		</Pressable>
	)
}

interface ThreadListProps {
	threads: ThreadSummary[]
}

export function ThreadList({ threads }: ThreadListProps) {
	const bottomPadding = useScreenBottomPadding()
	return (
		<LegendList
			data={threads}
			keyExtractor={(t) => t.threadId}
			contentContainerStyle={{ paddingBottom: bottomPadding }}
			estimatedItemSize={80}
			recycleItems
			ItemSeparatorComponent={() => <View className="mx-4 h-px bg-border" />}
			renderItem={({ item }) => <ThreadRow thread={item} />}
		/>
	)
}
