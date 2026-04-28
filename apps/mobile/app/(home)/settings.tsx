import { useState } from "react"
import { useClerk, useOrganization, useUser, useUserProfileModal } from "@clerk/expo"
import { UserButton } from "@clerk/expo/native"
import { Alert, Linking, Pressable, Text, View } from "react-native"
import { Screen } from "../../components/ui/screen"
import { ScreenHeader } from "../../components/ui/screen-header"
import { SectionHeader } from "../../components/ui/section-header"
import { Card } from "../../components/ui/card"
import { DestructiveButton, SecondaryButton } from "../../components/ui/button"
import { OrgSwitcherModal } from "../../components/org-switcher-modal"
import { hapticWarning } from "../../lib/haptics"
import { colors } from "../../lib/theme"

export default function SettingsScreen() {
	const { signOut } = useClerk()
	const { user } = useUser()
	const { presentUserProfile } = useUserProfileModal()
	const { organization } = useOrganization()
	const [orgModalVisible, setOrgModalVisible] = useState(false)

	return (
		<Screen scroll>
			<ScreenHeader title="Settings" />

			<View className="px-5">
				{/* Profile Section */}
				<View className="mb-6">
					<Card padding="lg">
						<View className="flex-row items-center mb-4">
							<View className="w-12 h-12 rounded-full overflow-hidden mr-4">
								<UserButton />
							</View>
							<View className="flex-1">
								<Text className="text-base font-bold text-foreground font-mono">
									{user?.firstName || "User"}
								</Text>
								<Text className="text-sm text-muted-foreground font-mono">
									{user?.primaryEmailAddress?.emailAddress}
								</Text>
							</View>
						</View>
						<SecondaryButton onPress={presentUserProfile}>Manage Profile</SecondaryButton>
					</Card>
				</View>

				{/* Organization */}
				{organization && (
					<View className="mb-6">
						<SectionHeader>Organization</SectionHeader>
						<Card padding="none">
							<Pressable
								className="flex-row justify-between items-center px-5 py-3.5"
								onPress={() => setOrgModalVisible(true)}
							>
								<View className="flex-row items-center">
									<View
										style={{
											width: 32,
											height: 32,
											borderRadius: 6,
											backgroundColor: colors.primary,
											alignItems: "center",
											justifyContent: "center",
											marginRight: 12,
										}}
									>
										<Text className="text-xs font-bold text-white font-mono">
											{organization.name.charAt(0).toUpperCase()}
										</Text>
									</View>
									<Text className="text-sm text-foreground font-mono">
										{organization.name}
									</Text>
								</View>
								<Text className="text-sm text-muted-foreground font-mono">›</Text>
							</Pressable>
						</Card>
					</View>
				)}

				{/* App Info */}
				<View className="mb-6">
					<SectionHeader>App</SectionHeader>
					<Card padding="none">
						<View className="flex-row justify-between items-center px-5 py-3.5 border-b border-border">
							<Text className="text-sm text-foreground font-mono">Version</Text>
							<Text className="text-sm text-muted-foreground font-mono">1.0.0</Text>
						</View>
						<View className="flex-row justify-between items-center px-5 py-3.5">
							<Text className="text-sm text-foreground font-mono">Build</Text>
							<Text className="text-sm text-muted-foreground font-mono">1</Text>
						</View>
					</Card>
				</View>

				{/* Legal */}
				<View className="mb-6">
					<SectionHeader>Legal</SectionHeader>
					<Card padding="none">
						<Pressable
							className="flex-row justify-between items-center px-5 py-3.5 border-b border-border"
							onPress={() => Linking.openURL("https://maple.dev/privacy")}
						>
							<Text className="text-sm text-foreground font-mono">Privacy Policy</Text>
							<Text className="text-sm text-muted-foreground font-mono">›</Text>
						</Pressable>
						<Pressable
							className="flex-row justify-between items-center px-5 py-3.5"
							onPress={() => Linking.openURL("https://maple.dev/terms")}
						>
							<Text className="text-sm text-foreground font-mono">Terms of Service</Text>
							<Text className="text-sm text-muted-foreground font-mono">›</Text>
						</Pressable>
					</Card>
				</View>

				{/* Sign Out */}
				<DestructiveButton onPress={() => signOut()}>Sign Out</DestructiveButton>

				{/* Delete Account */}
				<View className="mt-4">
					<DestructiveButton
						onPress={() => {
							Alert.alert(
								"Delete Account",
								"This will permanently delete your account and all associated data. This action cannot be undone.",
								[
									{ text: "Cancel", style: "cancel" },
									{
										text: "Delete",
										style: "destructive",
										onPress: async () => {
											hapticWarning()
											try {
												await user?.delete()
												signOut()
											} catch {
												Alert.alert(
													"Error",
													"Failed to delete account. Please try again.",
												)
											}
										},
									},
								],
							)
						}}
					>
						Delete Account
					</DestructiveButton>
				</View>
			</View>

			<OrgSwitcherModal visible={orgModalVisible} onClose={() => setOrgModalVisible(false)} />
		</Screen>
	)
}
