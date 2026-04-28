import { useAuth } from "@clerk/expo"
import { Redirect, Stack } from "expo-router"

export default function AuthLayout() {
	const { isSignedIn, isLoaded } = useAuth()

	if (isLoaded && isSignedIn) {
		return <Redirect href="/(home)" />
	}

	return <Stack screenOptions={{ headerShown: false }} />
}
