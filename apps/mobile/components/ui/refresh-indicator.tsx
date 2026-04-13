import { useEffect, useRef, useState } from "react"
import { Animated, Easing, Text, View } from "react-native"
import { colors } from "../../lib/theme"

const DOT_SIZE = 10
const HALO_SIZE = 22
const PULSE_DURATION_MS = 1100
const FADE_DURATION_MS = 220

interface RefreshIndicatorProps {
	active: boolean
}

export function RefreshIndicator({ active }: RefreshIndicatorProps) {
	const fade = useRef(new Animated.Value(0)).current
	const pulse = useRef(new Animated.Value(0)).current
	const [rendered, setRendered] = useState(active)

	useEffect(() => {
		if (active) {
			setRendered(true)
			const anim = Animated.timing(fade, {
				toValue: 1,
				duration: FADE_DURATION_MS,
				easing: Easing.out(Easing.quad),
				useNativeDriver: true,
			})
			anim.start()
			return () => {
				anim.stop()
			}
		}
		const anim = Animated.timing(fade, {
			toValue: 0,
			duration: FADE_DURATION_MS,
			easing: Easing.out(Easing.quad),
			useNativeDriver: true,
		})
		anim.start(({ finished }) => {
			if (finished) setRendered(false)
		})
		return () => {
			anim.stop()
		}
	}, [active, fade])

	useEffect(() => {
		if (!active) return
		pulse.setValue(0)
		const loop = Animated.loop(
			Animated.timing(pulse, {
				toValue: 1,
				duration: PULSE_DURATION_MS,
				easing: Easing.out(Easing.quad),
				useNativeDriver: true,
			}),
		)
		loop.start()
		return () => {
			loop.stop()
		}
	}, [active, pulse])

	const haloScale = pulse.interpolate({
		inputRange: [0, 1],
		outputRange: [0.4, 1],
	})
	const haloOpacity = Animated.multiply(
		fade,
		pulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
	)
	const dotScale = pulse.interpolate({
		inputRange: [0, 0.5, 1],
		outputRange: [1, 1.15, 1],
	})

	if (!rendered) return null

	return (
		<Animated.View
			style={{ opacity: fade }}
			className="flex-row items-center gap-2 px-2.5 py-1 rounded-full border border-primary/30"
		>
			<View
				style={{
					width: HALO_SIZE,
					height: HALO_SIZE,
					alignItems: "center",
					justifyContent: "center",
					marginLeft: -4,
				}}
			>
				<Animated.View
					style={{
						position: "absolute",
						width: HALO_SIZE,
						height: HALO_SIZE,
						borderRadius: HALO_SIZE / 2,
						backgroundColor: colors.primary,
						opacity: haloOpacity,
						transform: [{ scale: haloScale }],
					}}
				/>
				<Animated.View
					style={{
						width: DOT_SIZE,
						height: DOT_SIZE,
						borderRadius: DOT_SIZE / 2,
						backgroundColor: colors.primary,
						transform: [{ scale: dotScale }],
					}}
				/>
			</View>
			<Text
				className="text-[10px] font-mono font-bold uppercase tracking-widest"
				style={{ color: colors.primary }}
			>
				Syncing
			</Text>
		</Animated.View>
	)
}
