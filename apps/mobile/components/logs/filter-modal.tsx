import { useState } from "react"
import {
	FlatList,
	KeyboardAvoidingView,
	Modal,
	Platform,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from "react-native"
import type { LogsFacets } from "../../lib/api"
import { hapticLight, hapticMedium } from "../../lib/haptics"
import { severityColors } from "../../lib/theme"
import type { LogsFilterState } from "./filter-bar"

interface FilterModalProps {
	visible: boolean
	onClose: () => void
	currentFilters: LogsFilterState
	onApply: (filters: LogsFilterState) => void
	facets: LogsFacets | null
}

export function FilterModal({ visible, onClose, currentFilters, onApply, facets }: FilterModalProps) {
	const [draft, setDraft] = useState<LogsFilterState>(currentFilters)

	const handleOpen = () => {
		setDraft(currentFilters)
	}

	const handleApply = () => {
		hapticMedium()
		onApply(draft)
		onClose()
	}

	const handleReset = () => {
		hapticLight()
		setDraft({
			timeKey: "24h",
			service: "",
			severity: "",
			search: "",
		})
	}

	const hasActiveFilters = draft.service !== "" || draft.severity !== "" || draft.search !== ""

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
										<Text className="text-xs text-destructive font-mono">
											Reset all filters
										</Text>
									</TouchableOpacity>
								)}

								{/* Search */}
								<SectionLabel>Search</SectionLabel>
								<TextInput
									className="bg-card rounded-lg border border-border px-4 py-3 text-sm text-foreground font-mono mb-6"
									placeholder="Search log messages..."
									placeholderTextColor="#8a8078"
									value={draft.search}
									onChangeText={(v) => setDraft((d) => ({ ...d, search: v }))}
									autoCapitalize="none"
									autoCorrect={false}
								/>

								{/* Severity */}
								<SectionLabel>Severity</SectionLabel>
								<TextInput
									className="bg-card rounded-lg border border-border px-4 py-3 text-sm text-foreground font-mono mb-2"
									placeholder="Filter by severity..."
									placeholderTextColor="#8a8078"
									value={draft.severity}
									onChangeText={(v) => setDraft((d) => ({ ...d, severity: v }))}
									autoCapitalize="none"
									autoCorrect={false}
								/>
								{facets && facets.severities.length > 0 && (
									<View className="mb-6">
										{facets.severities.map((s) => {
											const color =
												severityColors[s.name.toUpperCase()] ?? severityColors.TRACE
											return (
												<TouchableOpacity
													key={s.name}
													onPress={() => {
														hapticLight()
														setDraft((d) => ({ ...d, severity: s.name }))
													}}
													className="flex-row items-center justify-between py-2.5 px-1"
												>
													<View className="flex-row items-center">
														<View
															className="w-2 h-2 rounded-full mr-2"
															style={{ backgroundColor: color }}
														/>
														<Text
															className={`text-sm font-mono ${draft.severity === s.name ? "text-primary" : "text-foreground"}`}
															numberOfLines={1}
														>
															{s.name}
														</Text>
													</View>
													<Text className="text-xs text-muted-foreground font-mono">
														{s.count}
													</Text>
												</TouchableOpacity>
											)
										})}
									</View>
								)}

								{/* Service */}
								<SectionLabel>Service</SectionLabel>
								<TextInput
									className="bg-card rounded-lg border border-border px-4 py-3 text-sm text-foreground font-mono mb-2"
									placeholder="Filter by service name..."
									placeholderTextColor="#8a8078"
									value={draft.service}
									onChangeText={(v) => setDraft((d) => ({ ...d, service: v }))}
									autoCapitalize="none"
									autoCorrect={false}
								/>
								{facets && facets.services.length > 0 && (
									<View className="mb-6">
										{facets.services.slice(0, 10).map((s) => (
											<TouchableOpacity
												key={s.name}
												onPress={() => {
													hapticLight()
													setDraft((d) => ({ ...d, service: s.name }))
												}}
												className="flex-row items-center justify-between py-2.5 px-1"
											>
												<Text
													className={`text-sm font-mono ${draft.service === s.name ? "text-primary" : "text-foreground"}`}
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
