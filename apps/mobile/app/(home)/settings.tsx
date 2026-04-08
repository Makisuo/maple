import { useClerk, useUser, useUserProfileModal } from "@clerk/expo";
import { UserButton } from "@clerk/expo/native";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";

export default function SettingsScreen() {
	const { signOut } = useClerk();
	const { user } = useUser();
	const { presentUserProfile } = useUserProfileModal();

	return (
		<View className="flex-1 bg-background">
			<ScrollView
				className="flex-1 px-5"
				contentContainerStyle={{ paddingBottom: 100 }}
			>
				<Text className="text-2xl font-bold text-foreground font-mono mt-16 mb-8">
					Settings
				</Text>

				{/* Profile Section */}
				<View className="bg-card rounded-xl p-5 mb-6">
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
					<TouchableOpacity
						className="bg-secondary rounded-lg px-4 py-3"
						onPress={presentUserProfile}
					>
						<Text className="text-secondary-foreground text-sm font-semibold font-mono text-center">
							Manage Profile
						</Text>
					</TouchableOpacity>
				</View>

				{/* App Info */}
				<Text className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3 px-1">
					App
				</Text>
				<View className="bg-card rounded-xl mb-6">
					<View className="flex-row justify-between items-center px-5 py-3.5 border-b border-border">
						<Text className="text-sm text-foreground font-mono">Version</Text>
						<Text className="text-sm text-muted-foreground font-mono">1.0.0</Text>
					</View>
					<View className="flex-row justify-between items-center px-5 py-3.5">
						<Text className="text-sm text-foreground font-mono">Build</Text>
						<Text className="text-sm text-muted-foreground font-mono">1</Text>
					</View>
				</View>

				{/* Sign Out */}
				<TouchableOpacity
					className="bg-destructive/10 rounded-xl px-4 py-3.5 mt-2"
					onPress={() => signOut()}
				>
					<Text className="text-destructive text-sm font-semibold font-mono text-center">
						Sign Out
					</Text>
				</TouchableOpacity>
			</ScrollView>
		</View>
	);
}
