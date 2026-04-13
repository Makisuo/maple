import "../global.css";

import { useCallback } from "react";
import { ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { useFonts } from "@expo-google-fonts/geist-mono/useFonts";
import { GeistMono_400Regular } from "@expo-google-fonts/geist-mono/400Regular";
import { GeistMono_700Bold } from "@expo-google-fonts/geist-mono/700Bold";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Slot } from "expo-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { setAuthTokenProvider } from "../lib/api";
import { mobileQueryClient } from "../lib/query";

SplashScreen.preventAutoHideAsync();

const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY!;

if (!publishableKey) {
	throw new Error("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is required");
}

function AuthBridge({ children }: { children: React.ReactNode }) {
	const { getToken, isSignedIn } = useAuth();

	useEffect(() => {
		if (isSignedIn) {
			setAuthTokenProvider(() => getToken());
		}
	}, [getToken, isSignedIn]);

	return <>{children}</>;
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
		<SafeAreaProvider>
			<View className="flex-1 bg-background" onLayout={onLayoutRootView}>
				<ClerkProvider
					publishableKey={publishableKey}
					tokenCache={tokenCache}
				>
					<QueryClientProvider client={mobileQueryClient}>
						<AuthBridge>
							<Slot />
						</AuthBridge>
					</QueryClientProvider>
				</ClerkProvider>
			</View>
		</SafeAreaProvider>
	);
}
