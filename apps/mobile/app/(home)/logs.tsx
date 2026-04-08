import { useState } from "react";
import { FlatList, RefreshControl, Text, View } from "react-native";

const SEVERITY_COLORS = {
	TRACE: "#8a8078",
	DEBUG: "#6b9ff0",
	INFO: "#5cb88a",
	WARN: "#c89b48",
	ERROR: "#c45a3c",
	FATAL: "#a03a20",
} as const;

type Severity = keyof typeof SEVERITY_COLORS;

const MOCK_LOGS: ReadonlyArray<{
	id: string;
	severity: Severity;
	timestamp: string;
	message: string;
	service: string;
}> = [
	{ id: "l1", severity: "INFO", timestamp: "14:23:45.123", message: "Request completed successfully", service: "api-gateway" },
	{ id: "l2", severity: "WARN", timestamp: "14:23:44.891", message: "Rate limit approaching threshold (85%)", service: "api-gateway" },
	{ id: "l3", severity: "ERROR", timestamp: "14:23:43.567", message: "Payment processing failed: insufficient funds", service: "payment-service" },
	{ id: "l4", severity: "DEBUG", timestamp: "14:23:42.234", message: "Cache hit for key: user:12345:profile", service: "user-service" },
	{ id: "l5", severity: "INFO", timestamp: "14:23:41.012", message: "New WebSocket connection established", service: "notification-svc" },
	{ id: "l6", severity: "ERROR", timestamp: "14:23:40.789", message: "Connection timeout after 30000ms", service: "search-service" },
	{ id: "l7", severity: "TRACE", timestamp: "14:23:39.456", message: "Executing query: SELECT * FROM spans WHERE ...", service: "query-engine" },
	{ id: "l8", severity: "INFO", timestamp: "14:23:38.123", message: "Health check passed", service: "api-gateway" },
	{ id: "l9", severity: "FATAL", timestamp: "14:23:37.001", message: "Out of memory: heap allocation failed", service: "ingest-worker" },
	{ id: "l10", severity: "WARN", timestamp: "14:23:36.789", message: "Deprecated API version v1 called", service: "api-gateway" },
];

export default function LogsScreen() {
	const [refreshing, setRefreshing] = useState(false);

	const onRefresh = () => {
		setRefreshing(true);
		setTimeout(() => setRefreshing(false), 1000);
	};

	return (
		<View className="flex-1 bg-background">
			<View className="px-5 pt-16 pb-3">
				<Text className="text-2xl font-bold text-foreground font-mono">
					Logs
				</Text>
			</View>

			<FlatList
				data={MOCK_LOGS}
				keyExtractor={(item) => item.id}
				contentContainerStyle={{ paddingBottom: 100 }}
				refreshControl={
					<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
				}
				renderItem={({ item }) => (
					<View className="flex-row px-5 py-2.5 border-b border-border">
						<View
							className="w-1 rounded-full mr-3 self-stretch"
							style={{ backgroundColor: SEVERITY_COLORS[item.severity] }}
						/>
						<View className="flex-1">
							<View className="flex-row items-center mb-1">
								<Text
									className="text-[10px] font-bold font-mono mr-2"
									style={{ color: SEVERITY_COLORS[item.severity] }}
								>
									{item.severity}
								</Text>
								<Text className="text-[10px] text-muted-foreground font-mono">
									{item.timestamp}
								</Text>
							</View>
							<Text
								className="text-xs text-foreground font-mono leading-4"
								numberOfLines={2}
							>
								{item.message}
							</Text>
							<Text className="text-[10px] text-muted-foreground font-mono mt-1">
								{item.service}
							</Text>
						</View>
					</View>
				)}
			/>
		</View>
	);
}
