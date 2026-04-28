import { useEffect, useRef, useState } from "react"
import { Animated, Pressable, TextInput, View } from "react-native"
import { colors } from "../../lib/theme"
import { hapticMedium } from "../../lib/haptics"
import { SendIcon } from "../icons/send-icon"
import { StopIcon } from "../icons/stop-icon"

interface ComposerProps {
	onSend: (text: string) => void
	onStop?: () => void
	isStreaming: boolean
	placeholder: string
}

export function Composer({ onSend, onStop, isStreaming, placeholder }: ComposerProps) {
	const [text, setText] = useState("")
	const pulse = useRef(new Animated.Value(0)).current
	const inputRef = useRef<TextInput>(null)

	useEffect(() => {
		if (!isStreaming) return
		pulse.setValue(0)
	}, [isStreaming, pulse])

	const canSend = text.trim().length > 0 && !isStreaming

	const triggerPulse = () => {
		pulse.setValue(1)
		Animated.timing(pulse, {
			toValue: 0,
			duration: 320,
			useNativeDriver: false,
		}).start()
	}

	const handleSend = () => {
		if (!canSend) return
		hapticMedium()
		triggerPulse()
		const toSend = text.trim()
		setText("")
		onSend(toSend)
	}

	const handleStop = () => {
		hapticMedium()
		onStop?.()
	}

	// Pulse interpolates from the theme border color to the primary accent.
	const animatedBorderColor = pulse.interpolate({
		inputRange: [0, 1],
		outputRange: ["rgba(0,0,0,0)", colors.primary],
	})

	return (
		<View className="px-4 pb-2 pt-1">
			<View
				className="flex-row items-center rounded-full border border-border bg-card pl-4 pr-1 py-1"
				style={{ minHeight: 44 }}
			>
				<Animated.View
					pointerEvents="none"
					style={{
						position: "absolute",
						left: 0,
						right: 0,
						top: 0,
						bottom: 0,
						borderRadius: 9999,
						borderWidth: 1,
						borderColor: animatedBorderColor,
					}}
				/>
				<TextInput
					ref={inputRef}
					value={text}
					onChangeText={setText}
					placeholder={placeholder}
					placeholderTextColor={colors.mutedForeground}
					className="flex-1 font-mono text-[14px] text-foreground"
					style={{ paddingVertical: 4 }}
					multiline
					maxLength={4000}
					onSubmitEditing={handleSend}
					blurOnSubmit={false}
					returnKeyType="send"
				/>
				{isStreaming ? (
					<Pressable
						onPress={handleStop}
						className="items-center justify-center bg-destructive"
						style={{ width: 36, height: 36, borderRadius: 18 }}
					>
						<StopIcon size={12} color={colors.primaryForeground} />
					</Pressable>
				) : (
					<Pressable
						onPress={handleSend}
						disabled={!canSend}
						className={`items-center justify-center ${canSend ? "bg-primary" : "bg-muted"}`}
						style={{ width: 36, height: 36, borderRadius: 18, opacity: canSend ? 1 : 0.7 }}
					>
						<SendIcon
							size={14}
							color={canSend ? colors.primaryForeground : colors.mutedForeground}
						/>
					</Pressable>
				)}
			</View>
		</View>
	)
}
