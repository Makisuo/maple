import { useUser } from "@clerk/expo";
import { UserButton } from "@clerk/expo/native";
import { ScrollView, Text, View } from "react-native";

const METRICS = [
	{ label: "Total Traces", value: "12,847" },
	{ label: "Error Rate", value: "2.3%", color: "#c45a3c" },
	{ label: "Avg Latency", value: "142ms" },
	{ label: "Active Services", value: "8" },
];

export default function DashboardScreen() {
	const { user } = useUser();

	return (
		<View className="flex-1 bg-background">
			<ScrollView
				className="flex-1"
				contentContainerStyle={{ paddingBottom: 100 }}
			>
				{/* Header */}
				<View className="flex-row justify-between items-center px-5 pt-16 pb-6">
					<View>
						<Text className="text-2xl font-bold text-foreground font-mono">
							maple
						</Text>
						<Text className="text-xs text-muted-foreground font-mono mt-0.5">
							{user?.primaryEmailAddress?.emailAddress}
						</Text>
					</View>
					<View className="w-9 h-9 rounded-full overflow-hidden">
						<UserButton />
					</View>
				</View>

				{/* Metrics Grid */}
				<View className="px-5">
					<Text className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3 px-1">
						Overview
					</Text>
					<View className="flex-row flex-wrap gap-3">
						{METRICS.map((metric) => (
							<View
								key={metric.label}
								className="bg-card rounded-xl p-4"
								style={{ width: "48%" }}
							>
								<Text className="text-xs text-muted-foreground font-mono mb-2">
									{metric.label}
								</Text>
								<Text
									className="text-2xl font-bold text-foreground font-mono"
									style={metric.color ? { color: metric.color } : undefined}
								>
									{metric.value}
								</Text>
							</View>
						))}
					</View>
				</View>

				{/* Recent Activity */}
				<View className="px-5 mt-8">
					<Text className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3 px-1">
						Recent Activity
					</Text>
					<View className="bg-card rounded-xl">
						{RECENT_ACTIVITY.map((item, i) => (
							<View
								key={item.id}
								className={`flex-row items-center px-4 py-3.5 ${i < RECENT_ACTIVITY.length - 1 ? "border-b border-border" : ""}`}
							>
								<View
									className="w-2 h-2 rounded-full mr-3"
									style={{
										backgroundColor:
											item.status === "Error" ? "#c45a3c" : "#5cb88a",
									}}
								/>
								<View className="flex-1">
									<Text
										className="text-sm text-foreground font-mono"
										numberOfLines={1}
									>
										{item.operation}
									</Text>
									<Text className="text-xs text-muted-foreground font-mono mt-0.5">
										{item.service} · {item.time}
									</Text>
								</View>
								<Text className="text-xs text-muted-foreground font-mono">
									{item.duration}
								</Text>
							</View>
						))}
					</View>
				</View>
			</ScrollView>
		</View>
	);
}

const RECENT_ACTIVITY = [
	{ id: "1", service: "api-gateway", operation: "GET /api/v1/traces", duration: "142ms", status: "Ok", time: "2m ago" },
	{ id: "2", service: "auth-service", operation: "POST /api/v1/login", duration: "89ms", status: "Ok", time: "5m ago" },
	{ id: "3", service: "payment-service", operation: "POST /api/v1/charge", duration: "2.1s", status: "Error", time: "8m ago" },
	{ id: "4", service: "user-service", operation: "GET /api/v1/users/me", duration: "45ms", status: "Ok", time: "12m ago" },
	{ id: "5", service: "notification-svc", operation: "POST /api/v1/notify", duration: "312ms", status: "Ok", time: "15m ago" },
];
