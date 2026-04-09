import type { ReactNode } from "react"
import { View } from "react-native"

type CardPadding = "none" | "md" | "lg"

interface CardProps {
	children: ReactNode
	padding?: CardPadding
	/** If false, omits the border. Defaults to true. */
	bordered?: boolean
}

const PADDING_CLASS: Record<CardPadding, string> = {
	none: "",
	md: "p-4",
	lg: "p-5",
}

export function Card({ children, padding = "md", bordered = true }: CardProps) {
	const paddingClass = PADDING_CLASS[padding]
	const borderClass = bordered ? "border border-border" : ""
	return (
		<View
			className={`bg-card rounded-xl overflow-hidden ${borderClass} ${paddingClass}`.trim()}
		>
			{children}
		</View>
	)
}
