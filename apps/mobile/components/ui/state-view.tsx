import { ActivityIndicator, Text, View } from "react-native"

export function LoadingView() {
	return (
		<View className="flex-1 items-center justify-center">
			<ActivityIndicator size="small" />
		</View>
	)
}

interface ErrorViewProps {
	message: string
	onRetry?: () => void
}

export function ErrorView({ message, onRetry }: ErrorViewProps) {
	return (
		<View className="flex-1 items-center justify-center px-5">
			<Text className="text-sm text-destructive font-mono text-center">{message}</Text>
			{onRetry ? (
				<Text className="text-sm text-primary font-mono mt-3" onPress={onRetry}>
					Tap to retry
				</Text>
			) : null}
		</View>
	)
}

interface EmptyViewProps {
	title: string
	description?: string
}

export function EmptyView({ title, description }: EmptyViewProps) {
	return (
		<View className="flex-1 items-center justify-center px-5 py-20">
			<Text className="text-sm text-muted-foreground font-mono text-center">{title}</Text>
			{description ? (
				<Text className="text-xs text-muted-foreground font-mono text-center mt-2">
					{description}
				</Text>
			) : null}
		</View>
	)
}
