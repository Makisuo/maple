import type { ReactNode } from "react"
import { ActivityIndicator, Pressable, Text } from "react-native"
import { colors } from "../../lib/theme"

type ButtonVariant = "primary" | "secondary" | "destructive"

interface ButtonProps {
	children: ReactNode
	onPress?: () => void
	disabled?: boolean
	loading?: boolean
	variant?: ButtonVariant
}

const CONTAINER_CLASS: Record<ButtonVariant, string> = {
	primary: "bg-primary",
	secondary: "bg-transparent border border-border",
	destructive: "bg-destructive/10",
}

const TEXT_CLASS: Record<ButtonVariant, string> = {
	primary: "text-primary-foreground",
	secondary: "text-foreground",
	destructive: "text-destructive",
}

const SPINNER_COLOR: Record<ButtonVariant, string> = {
	primary: colors.primaryForeground,
	secondary: colors.foreground,
	destructive: colors.error,
}

export function Button({
	children,
	onPress,
	disabled,
	loading,
	variant = "primary",
}: ButtonProps) {
	const isInactive = disabled || loading
	return (
		<Pressable
			className={`h-12 rounded-lg items-center justify-center px-4 ${CONTAINER_CLASS[variant]}`}
			onPress={onPress}
			disabled={isInactive}
			style={isInactive ? { opacity: 0.5 } : undefined}
		>
			{loading ? (
				<ActivityIndicator size="small" color={SPINNER_COLOR[variant]} />
			) : (
				<Text
					className={`text-sm font-medium font-mono ${TEXT_CLASS[variant]}`}
				>
					{children}
				</Text>
			)}
		</Pressable>
	)
}

export function PrimaryButton(props: Omit<ButtonProps, "variant">) {
	return <Button {...props} variant="primary" />
}

export function SecondaryButton(props: Omit<ButtonProps, "variant">) {
	return <Button {...props} variant="secondary" />
}

export function DestructiveButton(props: Omit<ButtonProps, "variant">) {
	return <Button {...props} variant="destructive" />
}
