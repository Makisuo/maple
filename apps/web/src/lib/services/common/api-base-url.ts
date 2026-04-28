const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim()

export const apiBaseUrl =
	configuredApiBaseUrl && configuredApiBaseUrl.length > 0
		? configuredApiBaseUrl.replace(/\/$/, "")
		: "http://127.0.0.1:3472"
