import { useState } from "react";
import { FlatList, RefreshControl, Text, View } from "react-native";

const STATUS_COLORS = {
	Ok: "#5cb88a",
	Error: "#c45a3c",
	Unset: "#8a8078",
} as const;

const MOCK_TRACES = [
	{ id: "t1", service: "api-gateway", operation: "GET /api/v1/traces", duration: "142ms", status: "Ok", spans: 12 },
	{ id: "t2", service: "auth-service", operation: "POST /api/v1/login", duration: "89ms", status: "Ok", spans: 5 },
	{ id: "t3", service: "payment-service", operation: "POST /api/v1/charge", duration: "2.1s", status: "Error", spans: 18 },
	{ id: "t4", service: "user-service", operation: "GET /api/v1/users/me", duration: "45ms", status: "Ok", spans: 3 },
	{ id: "t5", service: "notification-svc", operation: "POST /api/v1/notify", duration: "312ms", status: "Ok", spans: 8 },
	{ id: "t6", service: "search-service", operation: "GET /api/v1/search", duration: "567ms", status: "Ok", spans: 14 },
	{ id: "t7", service: "api-gateway", operation: "GET /api/v1/logs", duration: "98ms", status: "Ok", spans: 6 },
	{ id: "t8", service: "payment-service", operation: "POST /api/v1/refund", duration: "1.8s", status: "Error", spans: 22 },
];

export default function TracesScreen() {
	const [refreshing, setRefreshing] = useState(false);

	const onRefresh = () => {
		setRefreshing(true);
		setTimeout(() => setRefreshing(false), 1000);
	};

	return (
		<View className="flex-1 bg-background">
			<View className="px-5 pt-16 pb-3">
				<Text className="text-2xl font-bold text-foreground font-mono">
					Traces
				</Text>
			</View>

			<FlatList
				data={MOCK_TRACES}
				keyExtractor={(item) => item.id}
				contentContainerStyle={{ paddingBottom: 100, paddingHorizontal: 20 }}
				refreshControl={
					<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
				}
				ItemSeparatorComponent={() => <View className="h-2" />}
				renderItem={({ item }) => (
					<View className="bg-card rounded-xl px-4 py-3.5">
						<View className="flex-row justify-between items-start">
							<View className="flex-1 mr-3">
								<Text
									className="text-sm font-bold text-foreground font-mono"
									numberOfLines={1}
								>
									{item.operation}
								</Text>
								<Text className="text-xs text-muted-foreground font-mono mt-1">
									{item.service}
								</Text>
							</View>
							<View className="items-end">
								<Text className="text-sm font-bold text-foreground font-mono">
									{item.duration}
								</Text>
								<View className="flex-row items-center mt-1">
									<View
										className="w-1.5 h-1.5 rounded-full mr-1.5"
										style={{
											backgroundColor:
												STATUS_COLORS[item.status as keyof typeof STATUS_COLORS],
										}}
									/>
									<Text className="text-xs text-muted-foreground font-mono">
										{item.spans} spans
									</Text>
								</View>
							</View>
						</View>
					</View>
				)}
			/>
		</View>
	);
}
