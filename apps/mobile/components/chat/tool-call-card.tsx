import { useEffect, useRef, useState } from "react"
import { Animated, Pressable, Text, View } from "react-native"
import { colors } from "../../lib/theme"
import { hapticLight } from "../../lib/haptics"

type ToolState = "input-streaming" | "input-available" | "output-available" | "output-error"

interface ToolCallCardProps {
	toolName: string
	state: ToolState
	input?: unknown
	output?: unknown
	errorText?: string
}

const statusMeta = (state: ToolState): { label: string; color: string; pulsing: boolean } => {
	switch (state) {
		case "input-streaming":
			return { label: "preparing", color: colors.mutedForeground, pulsing: true }
		case "input-available":
			return { label: "running", color: colors.primary, pulsing: true }
		case "output-available":
			return { label: "done", color: colors.success, pulsing: false }
		case "output-error":
			return { label: "errored", color: colors.error, pulsing: false }
	}
}

function StatusDot({ color, pulsing }: { color: string; pulsing: boolean }) {
	const opacity = useRef(new Animated.Value(1)).current
	useEffect(() => {
		if (!pulsing) return
		const loop = Animated.loop(
			Animated.sequence([
				Animated.timing(opacity, { toValue: 0.35, duration: 600, useNativeDriver: true }),
				Animated.timing(opacity, { toValue: 1, duration: 600, useNativeDriver: true }),
			]),
		)
		loop.start()
		return () => loop.stop()
	}, [pulsing, opacity])
	return (
		<Animated.View
			style={{
				width: 6,
				height: 6,
				borderRadius: 3,
				backgroundColor: color,
				opacity: pulsing ? opacity : 1,
			}}
		/>
	)
}

function formatJson(value: unknown): string {
	if (value === undefined) return ""
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}

export function ToolCallCard({ toolName, state, input, output, errorText }: ToolCallCardProps) {
	const [expanded, setExpanded] = useState(false)
	const meta = statusMeta(state)
	const hasDetails = input !== undefined || output !== undefined || errorText !== undefined

	return (
		<Pressable
			onPress={() => {
				if (!hasDetails) return
				hapticLight()
				setExpanded((v) => !v)
			}}
			className="rounded-md border border-border bg-card"
		>
			<View className="flex-row items-center gap-2 px-3 py-2.5">
				<StatusDot color={meta.color} pulsing={meta.pulsing} />
				<Text
					className="font-mono text-[11px] text-foreground flex-1"
					style={{ letterSpacing: 1.5 }}
				>
					{toolName.toUpperCase()}
				</Text>
				<Text
					className="font-mono text-[10px]"
					style={{ color: meta.color, letterSpacing: 1.2 }}
				>
					{meta.label.toUpperCase()}
				</Text>
			</View>
			{expanded && hasDetails ? (
				<View className="gap-2 border-t border-border px-3 pb-3 pt-2">
					{input !== undefined ? (
						<View className="gap-1">
							<Text
								className="font-mono text-[10px] text-muted-foreground"
								style={{ letterSpacing: 1.2 }}
							>
								INPUT
							</Text>
							<Text
								className="font-mono text-[11px] text-foreground"
								selectable
								style={{ lineHeight: 16 }}
							>
								{formatJson(input)}
							</Text>
						</View>
					) : null}
					{output !== undefined ? (
						<View className="gap-1">
							<Text
								className="font-mono text-[10px] text-muted-foreground"
								style={{ letterSpacing: 1.2 }}
							>
								OUTPUT
							</Text>
							<Text
								className="font-mono text-[11px] text-foreground"
								selectable
								style={{ lineHeight: 16 }}
							>
								{formatJson(output)}
							</Text>
						</View>
					) : null}
					{errorText ? (
						<View className="gap-1">
							<Text
								className="font-mono text-[10px] text-destructive"
								style={{ letterSpacing: 1.2 }}
							>
								ERROR
							</Text>
							<Text
								className="font-mono text-[11px] text-destructive"
								selectable
							>
								{errorText}
							</Text>
						</View>
					) : null}
				</View>
			) : null}
		</Pressable>
	)
}
