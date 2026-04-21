import { useEffect } from "react"
import { useRouter, useLocalSearchParams } from "expo-router"
import { View } from "react-native"
import { alertThreadId, decodeAlertContextFromSearchParam } from "../../lib/alert-context"

function randomThreadId(): string {
	const rand =
		typeof globalThis.crypto !== "undefined" && "randomUUID" in globalThis.crypto
			? globalThis.crypto.randomUUID()
			: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
	return `chat-${rand}`
}

export default function NewChat() {
	const router = useRouter()
	const params = useLocalSearchParams<{ alert?: string }>()

	useEffect(() => {
		const alertParam = typeof params.alert === "string" ? params.alert : undefined
		const alert = alertParam ? decodeAlertContextFromSearchParam(alertParam) : undefined

		const threadId = alert ? alertThreadId(alert) : randomThreadId()
		const path = alert
			? `/ask/${encodeURIComponent(threadId)}?alert=${encodeURIComponent(alertParam!)}`
			: `/ask/${encodeURIComponent(threadId)}`
		router.replace(path)
	}, [params.alert, router])

	return <View className="flex-1 bg-background" />
}
