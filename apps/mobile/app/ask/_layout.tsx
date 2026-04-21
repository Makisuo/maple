import { useAuth } from "@clerk/expo"
import { Redirect, Stack } from "expo-router"

export default function AskLayout() {
	const { isSignedIn, isLoaded } = useAuth({ treatPendingAsSignedOut: false })

	if (!isLoaded) return null
	if (!isSignedIn) return <Redirect href="/(auth)" />

	return (
		<Stack
			screenOptions={{
				headerShown: false,
				contentStyle: { backgroundColor: "transparent" },
			}}
		/>
	)
}
