import "../global.css";

import { useCallback } from "react";
import { ClerkProvider } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { useFonts } from "@expo-google-fonts/geist-mono/useFonts";
import { GeistMono_400Regular } from "@expo-google-fonts/geist-mono/400Regular";
import { GeistMono_700Bold } from "@expo-google-fonts/geist-mono/700Bold";
import * as SplashScreen from "expo-splash-screen";
import { View } from "react-native";
import { Slot } from "expo-router";

SplashScreen.preventAutoHideAsync();

const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY!;

if (!publishableKey) {
	throw new Error("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is required");
}

export default function RootLayout() {
	const [fontsLoaded] = useFonts({
		GeistMono_400Regular,
		GeistMono_700Bold,
	});

	const onLayoutRootView = useCallback(async () => {
		if (fontsLoaded) {
			await SplashScreen.hideAsync();
		}
	}, [fontsLoaded]);

	if (!fontsLoaded) {
		return null;
	}

	return (
		<View className="flex-1 bg-background" onLayout={onLayoutRootView}>
			<ClerkProvider
				publishableKey={publishableKey}
				tokenCache={tokenCache}
			>
				<Slot />
			</ClerkProvider>
		</View>
	);
}
