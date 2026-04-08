import { AuthView } from "@clerk/expo/native";
import { View } from "react-native";

export default function AuthScreen() {
	return (
		<View style={{ flex: 1 }}>
			<AuthView mode="signInOrUp" />
		</View>
	);
}
