import { useOrganization, useOrganizationList } from "@clerk/expo"
import { useRouter } from "expo-router"
import { ActivityIndicator, FlatList, Image, Modal, Text, TouchableOpacity, View } from "react-native"
import { hapticSelection } from "../lib/haptics"
import { colors } from "../lib/theme"

interface OrgSwitcherModalProps {
	visible: boolean
	onClose: () => void
}

function OrgAvatar({ name, imageUrl }: { name: string; imageUrl?: string | null }) {
	const initial = name.charAt(0).toUpperCase()
	if (imageUrl) {
		return <Image source={{ uri: imageUrl }} style={{ width: 32, height: 32, borderRadius: 6 }} />
	}
	return (
		<View
			style={{
				width: 32,
				height: 32,
				borderRadius: 6,
				backgroundColor: colors.primary,
				alignItems: "center",
				justifyContent: "center",
			}}
		>
			<Text className="text-xs font-bold text-white font-mono">{initial}</Text>
		</View>
	)
}

export function OrgSwitcherModal({ visible, onClose }: OrgSwitcherModalProps) {
	const router = useRouter()
	const { organization } = useOrganization()
	const { isLoaded, userMemberships, setActive } = useOrganizationList({
		userMemberships: { infinite: true },
	})

	const memberships = userMemberships?.data ?? []

	// Fall back to the current organization when the memberships list is empty
	const orgs =
		memberships.length > 0
			? memberships.map((m) => m.organization)
			: organization
				? [{ id: organization.id, name: organization.name, imageUrl: organization.imageUrl }]
				: []

	const handleSwitch = async (orgId: string) => {
		if (!setActive || organization?.id === orgId) {
			onClose()
			return
		}
		hapticSelection()
		await setActive({ organization: orgId })
		onClose()
		router.replace("/(home)")
	}

	const loading = !isLoaded || userMemberships?.isLoading

	return (
		<Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
			<View className="flex-1 bg-background">
				{/* Header */}
				<View className="flex-row items-center justify-between px-5 pt-5 pb-4">
					<TouchableOpacity onPress={onClose}>
						<Text className="text-sm text-muted-foreground font-mono">Cancel</Text>
					</TouchableOpacity>
					<Text className="text-base font-bold text-foreground font-mono">Organization</Text>
					<View style={{ width: 48 }} />
				</View>

				{loading ? (
					<View className="flex-1 items-center justify-center">
						<ActivityIndicator color={colors.primary} />
					</View>
				) : (
					<FlatList
						data={orgs}
						keyExtractor={(item) => item.id}
						contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}
						renderItem={({ item: org }) => (
							<TouchableOpacity
								onPress={() => handleSwitch(org.id)}
								className="flex-row items-center py-3.5 border-b border-border"
							>
								<OrgAvatar name={org.name} imageUrl={org.imageUrl} />
								<Text
									className="flex-1 text-sm text-foreground font-mono ml-3"
									numberOfLines={1}
								>
									{org.name}
								</Text>
								{organization?.id === org.id && (
									<Text style={{ color: colors.primary, fontSize: 16 }}>✓</Text>
								)}
							</TouchableOpacity>
						)}
						ListEmptyComponent={
							<View className="items-center py-10">
								<Text className="text-sm text-muted-foreground font-mono">
									No organizations found
								</Text>
							</View>
						}
					/>
				)}
			</View>
		</Modal>
	)
}
