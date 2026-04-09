import type { ReactNode } from "react"
import { ScrollView, View, type ScrollViewProps } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

// Approximate height of the NativeTabs UITabBar on iOS. The safe-area bottom
// inset covers the home indicator; this covers the bar itself.
const TAB_BAR_HEIGHT = 56

interface ScreenProps {
	children: ReactNode
	/** If true, wraps children in a ScrollView that handles bottom tab-bar padding. */
	scroll?: boolean
	/** Extra bottom padding added beyond the tab-bar offset (scroll mode only). */
	extraBottomPadding?: number
	scrollViewProps?: Omit<ScrollViewProps, "contentContainerStyle">
}

export function Screen({
	children,
	scroll,
	extraBottomPadding = 0,
	scrollViewProps,
}: ScreenProps) {
	const insets = useSafeAreaInsets()
	const topPadding = insets.top
	const bottomPadding = insets.bottom + TAB_BAR_HEIGHT + extraBottomPadding

	if (scroll) {
		return (
			<View className="flex-1 bg-background" style={{ paddingTop: topPadding }}>
				<ScrollView
					className="flex-1"
					contentContainerStyle={{ paddingBottom: bottomPadding }}
					{...scrollViewProps}
				>
					{children}
				</ScrollView>
			</View>
		)
	}

	return (
		<View className="flex-1 bg-background" style={{ paddingTop: topPadding }}>
			{children}
		</View>
	)
}

/** Hook for list screens that manage their own scroll container (e.g. LegendList, FlatList). */
export function useScreenBottomPadding(extra = 0) {
	const insets = useSafeAreaInsets()
	return insets.bottom + TAB_BAR_HEIGHT + extra
}
