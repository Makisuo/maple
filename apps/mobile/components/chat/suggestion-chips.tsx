import { Pressable, ScrollView, Text } from "react-native"
import { hapticLight } from "../../lib/haptics"

interface SuggestionChipsProps {
	suggestions: string[]
	onPick: (suggestion: string) => void
}

export function SuggestionChips({ suggestions, onPick }: SuggestionChipsProps) {
	if (suggestions.length === 0) return null
	return (
		<ScrollView
			horizontal
			showsHorizontalScrollIndicator={false}
			contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}
		>
			{suggestions.map((s) => (
				<Pressable
					key={s}
					onPress={() => {
						hapticLight()
						onPick(s)
					}}
					className="rounded-full border border-border bg-card px-3.5 py-2"
				>
					<Text className="font-mono text-[12px] text-foreground" numberOfLines={1}>
						{s}
					</Text>
				</Pressable>
			))}
		</ScrollView>
	)
}
