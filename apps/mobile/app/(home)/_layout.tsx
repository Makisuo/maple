import { useAuth } from "@clerk/expo"
import { Redirect } from "expo-router"
import { NativeTabs } from "expo-router/unstable-native-tabs"

export default function HomeLayout() {
	const { isSignedIn, isLoaded } = useAuth({ treatPendingAsSignedOut: false })

	if (!isLoaded) {
		return null
	}

	if (!isSignedIn) {
		return <Redirect href="/(auth)" />
	}

	return (
		<NativeTabs>
			<NativeTabs.Trigger name="index">
				<NativeTabs.Trigger.Label>Overview</NativeTabs.Trigger.Label>
				<NativeTabs.Trigger.Icon sf="house" />
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="services">
				<NativeTabs.Trigger.Label>Services</NativeTabs.Trigger.Label>
				<NativeTabs.Trigger.Icon sf="square.grid.2x2" />
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="traces">
				<NativeTabs.Trigger.Label>Traces</NativeTabs.Trigger.Label>
				<NativeTabs.Trigger.Icon sf="point.3.connected.trianglepath.dotted" />
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="dashboards">
				<NativeTabs.Trigger.Label>Dashboards</NativeTabs.Trigger.Label>
				<NativeTabs.Trigger.Icon sf="chart.bar.xaxis" />
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="logs">
				<NativeTabs.Trigger.Label>Logs</NativeTabs.Trigger.Label>
				<NativeTabs.Trigger.Icon sf="terminal" />
			</NativeTabs.Trigger>
		</NativeTabs>
	)
}
