import { useClerk, useUser, useUserProfileModal } from "@clerk/expo"
import { UserButton } from "@clerk/expo/native"
import { Text, View } from "react-native"
import { Screen } from "../../components/ui/screen"
import { ScreenHeader } from "../../components/ui/screen-header"
import { SectionHeader } from "../../components/ui/section-header"
import { Card } from "../../components/ui/card"
import {
	DestructiveButton,
	SecondaryButton,
} from "../../components/ui/button"

export default function SettingsScreen() {
	const { signOut } = useClerk()
	const { user } = useUser()
	const { presentUserProfile } = useUserProfileModal()

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
						<SecondaryButton onPress={presentUserProfile}>
							Manage Profile
						</SecondaryButton>
					</Card>
				</View>

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

				{/* Sign Out */}
				<DestructiveButton onPress={() => signOut()}>Sign Out</DestructiveButton>
			</View>
		</Screen>
	)
}
