import { useClerk, useUser, useUserProfileModal } from "@clerk/expo";
import { UserButton } from "@clerk/expo/native";
import { Text, TouchableOpacity, View } from "react-native";

export default function HomeScreen() {
	const { signOut } = useClerk();
	const { user } = useUser();
	const { presentUserProfile } = useUserProfileModal();

	return (
		<View className="flex-1 justify-center items-center p-6 bg-background">
			<View className="w-11 h-11 rounded-full overflow-hidden mb-4">
				<UserButton />
			</View>
			<Text className="text-[28px] font-bold text-foreground font-mono">
				maple
			</Text>
			<Text className="text-base text-muted-foreground mt-2 font-mono">
				Signed in as {user?.primaryEmailAddress?.emailAddress}
			</Text>
			<TouchableOpacity
				className="bg-secondary rounded-lg px-6 py-3.5 mt-8"
				onPress={presentUserProfile}
			>
				<Text className="text-secondary-foreground text-base font-semibold font-mono">
					Manage Profile
				</Text>
			</TouchableOpacity>
			<TouchableOpacity
				className="bg-primary rounded-lg px-6 py-3.5 mt-4"
				onPress={() => signOut()}
			>
				<Text className="text-primary-foreground text-base font-semibold font-mono">
					Sign out
				</Text>
			</TouchableOpacity>
		</View>
	);
}
