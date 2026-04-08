import { useState } from "react"
import {
	FlatList,
	KeyboardAvoidingView,
	Modal,
	Platform,
	Switch,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from "react-native"
import { Host, Picker, Text as ExpoText } from "@expo/ui/swift-ui"
import { pickerStyle, tag } from "@expo/ui/swift-ui/modifiers"
import type { TimeRangeKey } from "../../lib/time-utils"
import type { TracesFacets } from "../../lib/api"
import type { TracesFilterState } from "./filter-bar"

const TIME_OPTIONS: TimeRangeKey[] = ["1h", "24h", "7d", "30d"]

interface FilterModalProps {
	visible: boolean
	onClose: () => void
	currentFilters: TracesFilterState
	onApply: (filters: TracesFilterState) => void
	facets: TracesFacets | null
}

export function FilterModal({ visible, onClose, currentFilters, onApply, facets }: FilterModalProps) {
	const [draft, setDraft] = useState<TracesFilterState>(currentFilters)

	const handleOpen = () => {
		setDraft(currentFilters)
	}

	const handleApply = () => {
		onApply(draft)
		onClose()
	}

	const handleReset = () => {
		setDraft({
			timeKey: "24h",
			serviceName: "",
			spanName: "",
			errorsOnly: false,
		})
	}

	const hasActiveFilters =
		draft.serviceName !== "" || draft.spanName !== "" || draft.errorsOnly || draft.timeKey !== "24h"

	const timeIndex = TIME_OPTIONS.indexOf(draft.timeKey)

	return (
		<Modal
			visible={visible}
			animationType="slide"
			presentationStyle="pageSheet"
			onRequestClose={onClose}
			onShow={handleOpen}
		>
			<View className="flex-1 bg-background">
				{/* Header */}
				<View className="flex-row items-center justify-between px-5 pt-5 pb-4">
					<TouchableOpacity onPress={onClose}>
						<Text className="text-sm text-muted-foreground font-mono">Cancel</Text>
					</TouchableOpacity>
					<Text className="text-base font-bold text-foreground font-mono">Filters</Text>
					<TouchableOpacity onPress={handleApply}>
						<Text className="text-sm text-primary font-mono font-bold">Apply</Text>
					</TouchableOpacity>
				</View>

				<KeyboardAvoidingView
					behavior={Platform.OS === "ios" ? "padding" : "height"}
					className="flex-1"
				>
					<FlatList
						data={[null]}
						renderItem={() => (
							<View className="px-5 pb-10">
								{/* Reset */}
								{hasActiveFilters && (
									<TouchableOpacity onPress={handleReset} className="mb-4">
										<Text className="text-xs text-destructive font-mono">Reset all filters</Text>
									</TouchableOpacity>
								)}

								{/* Time Range */}
								<SectionLabel>Time Range</SectionLabel>
								<View className="mb-6">
									<Host matchContents={{ vertical: true }} style={{ width: "100%" }}>
										<Picker
											selection={timeIndex}
											onSelectionChange={(value) => {
												const idx = value as number
												if (TIME_OPTIONS[idx]) {
													setDraft((d) => ({ ...d, timeKey: TIME_OPTIONS[idx] }))
												}
											}}
											modifiers={[pickerStyle("segmented")]}
										>
											{TIME_OPTIONS.map((opt, i) => (
												<ExpoText key={opt} modifiers={[tag(i)]}>
													{opt}
												</ExpoText>
											))}
										</Picker>
									</Host>
								</View>

								{/* Errors Only */}
								<SectionLabel>Status</SectionLabel>
								<View className="flex-row items-center justify-between bg-card rounded-lg border border-border px-4 py-3 mb-6">
									<Text className="text-sm text-foreground font-mono">Errors only</Text>
									<Switch
										value={draft.errorsOnly}
										onValueChange={(v) => setDraft((d) => ({ ...d, errorsOnly: v }))}
									/>
								</View>

								{/* Service Name */}
								<SectionLabel>Service</SectionLabel>
								<TextInput
									className="bg-card rounded-lg border border-border px-4 py-3 text-sm text-foreground font-mono mb-2"
									placeholder="Filter by service name..."
									placeholderTextColor="#8a8078"
									value={draft.serviceName}
									onChangeText={(v) => setDraft((d) => ({ ...d, serviceName: v }))}
									autoCapitalize="none"
									autoCorrect={false}
								/>
								{facets && facets.services.length > 0 && (
									<View className="mb-6">
										{facets.services.slice(0, 10).map((s) => (
											<TouchableOpacity
												key={s.name}
												onPress={() => setDraft((d) => ({ ...d, serviceName: s.name }))}
												className="flex-row items-center justify-between py-2.5 px-1"
											>
												<Text
													className={`text-sm font-mono ${draft.serviceName === s.name ? "text-primary" : "text-foreground"}`}
													numberOfLines={1}
												>
													{s.name}
												</Text>
												<Text className="text-xs text-muted-foreground font-mono">
													{s.count}
												</Text>
											</TouchableOpacity>
										))}
									</View>
								)}

								{/* Span Name */}
								<SectionLabel>Span Name</SectionLabel>
								<TextInput
									className="bg-card rounded-lg border border-border px-4 py-3 text-sm text-foreground font-mono mb-2"
									placeholder="Filter by span name..."
									placeholderTextColor="#8a8078"
									value={draft.spanName}
									onChangeText={(v) => setDraft((d) => ({ ...d, spanName: v }))}
									autoCapitalize="none"
									autoCorrect={false}
								/>
								{facets && facets.spanNames.length > 0 && (
									<View className="mb-6">
										{facets.spanNames.slice(0, 10).map((s) => (
											<TouchableOpacity
												key={s.name}
												onPress={() => setDraft((d) => ({ ...d, spanName: s.name }))}
												className="flex-row items-center justify-between py-2.5 px-1"
											>
												<Text
													className={`text-sm font-mono ${draft.spanName === s.name ? "text-primary" : "text-foreground"}`}
													numberOfLines={1}
												>
													{s.name}
												</Text>
												<Text className="text-xs text-muted-foreground font-mono">
													{s.count}
												</Text>
											</TouchableOpacity>
										))}
									</View>
								)}
							</View>
						)}
						keyExtractor={() => "form"}
					/>
				</KeyboardAvoidingView>
			</View>
		</Modal>
	)
}

function SectionLabel({ children }: { children: string }) {
	return (
		<Text className="text-xs text-muted-foreground font-mono uppercase tracking-widest mb-2 px-1">
			{children}
		</Text>
	)
}
