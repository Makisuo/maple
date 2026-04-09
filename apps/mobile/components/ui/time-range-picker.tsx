import { Host, Picker, Text as ExpoText } from "@expo/ui/swift-ui"
import { pickerStyle, tag } from "@expo/ui/swift-ui/modifiers"
import { segmentedTint } from "expo-ui-ext"
import { View } from "react-native"
import type { TimeRangeKey } from "../../lib/time-utils"
import { colors } from "../../lib/theme"

const DEFAULT_OPTIONS: readonly TimeRangeKey[] = ["1h", "24h", "7d", "30d"]

interface TimeRangePickerProps {
	selectedIndex: number
	onChange: (index: number) => void
	options?: readonly TimeRangeKey[]
}

export function TimeRangePicker({
	selectedIndex,
	onChange,
	options = DEFAULT_OPTIONS,
}: TimeRangePickerProps) {
	return (
		<View className="px-5 pb-4">
			<Host matchContents={{ vertical: true }} style={{ width: "100%" }}>
				<Picker
					selection={selectedIndex}
					onSelectionChange={(value) => onChange(value as number)}
					modifiers={[pickerStyle("segmented"), segmentedTint(colors.primary)]}
				>
					{options.map((option, i) => (
						<ExpoText key={option} modifiers={[tag(i)]}>
							{option}
						</ExpoText>
					))}
				</Picker>
			</Host>
		</View>
	)
}
