import { useAuth } from "@clerk/expo"
import { Redirect, Stack } from "expo-router"

export default function HomeLayout() {
  const { isSignedIn, isLoaded } = useAuth({ treatPendingAsSignedOut: false })

  if (!isLoaded) {
    return null
  }

  if (!isSignedIn) {
    return <Redirect href="/(auth)" />
  }

  return <Stack />
}
