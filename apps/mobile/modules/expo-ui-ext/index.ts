import { createModifier, type ModifierConfig } from "@expo/ui/swift-ui/modifiers"

/**
 * Sets the selected-segment tint color on any segmented `Picker` downstream.
 * Applied globally via `UISegmentedControl.appearance()`, so it stays
 * consistent across every segmented picker in the app.
 */
export const segmentedTint = (color: string): ModifierConfig => createModifier("segmentedTint", { color })
