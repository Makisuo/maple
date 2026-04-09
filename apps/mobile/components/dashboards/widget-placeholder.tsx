import { Text, View } from "react-native"

interface WidgetPlaceholderProps {
	kind: "loading" | "error" | "unsupported"
	message?: string
}

const KIND_LABEL: Record<WidgetPlaceholderProps["kind"], string> = {
	loading: "Loading…",
	error: "Failed to load",
	unsupported: "Not yet supported on mobile",
}

export function WidgetPlaceholder({ kind, message }: WidgetPlaceholderProps) {
	return (
		<View
			className="items-center justify-center"
			style={{ height: 100 }}
		>
			<Text className="text-xs text-muted-foreground font-mono">
				{KIND_LABEL[kind]}
			</Text>
			{message ? (
				<Text
					className="text-[10px] text-muted-foreground font-mono mt-1 px-2 text-center"
					numberOfLines={2}
				>
					{message}
				</Text>
			) : null}
		</View>
	)
}
