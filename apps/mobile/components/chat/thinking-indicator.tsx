import { useEffect, useRef } from "react"
import { Animated, View } from "react-native"
import { colors } from "../../lib/theme"

// Classic typing-dots: three copper dots bouncing up in sequence.
// Native-driver friendly (translateY + opacity only).
export function ThinkingIndicator() {
	const a = useRef(new Animated.Value(0)).current
	const b = useRef(new Animated.Value(0)).current
	const c = useRef(new Animated.Value(0)).current

	useEffect(() => {
		const bounce = (v: Animated.Value) =>
			Animated.sequence([
				Animated.timing(v, { toValue: 1, duration: 280, useNativeDriver: true }),
				Animated.timing(v, { toValue: 0, duration: 280, useNativeDriver: true }),
				Animated.delay(440),
			])

		const loop = Animated.loop(Animated.stagger(140, [bounce(a), bounce(b), bounce(c)]))
		loop.start()
		return () => loop.stop()
	}, [a, b, c])

	const makeStyle = (v: Animated.Value) =>
		({
			width: 5,
			height: 5,
			borderRadius: 3,
			backgroundColor: colors.primary,
			opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
			transform: [
				{
					translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -4] }),
				},
			],
		}) as const

	return (
		<View className="flex-row items-center gap-1.5 py-2" style={{ height: 20 }}>
			<Animated.View style={makeStyle(a)} />
			<Animated.View style={makeStyle(b)} />
			<Animated.View style={makeStyle(c)} />
		</View>
	)
}
