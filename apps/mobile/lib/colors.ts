export const HTTP_METHOD_COLORS: Record<string, string> = {
	GET: "#4A9EFF",
	POST: "#E8872B",
	PUT: "#4AA865",
	PATCH: "#8A7F72",
	DELETE: "#E85D4A",
	HEAD: "#8A7F72",
	OPTIONS: "#5A5248",
}

const SERVICE_HUES = [250, 185, 155, 130, 90, 60, 45, 25, 0, 340, 320, 290, 270, 260, 210, 230]

function hashString(str: string): number {
	let hash = 0
	for (let i = 0; i < str.length; i++) {
		hash = str.charCodeAt(i) + ((hash << 5) - hash)
	}
	return Math.abs(hash)
}

function hslToHex(h: number, s: number, l: number): string {
	const a = s * Math.min(l, 1 - l)
	const f = (n: number) => {
		const k = (n + h / 30) % 12
		const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
		return Math.round(255 * color)
			.toString(16)
			.padStart(2, "0")
	}
	return `#${f(0)}${f(8)}${f(4)}`
}

export function getServiceColor(serviceName: string): string {
	const index = hashString(serviceName) % SERVICE_HUES.length
	const hue = SERVICE_HUES[index]
	return hslToHex(hue, 0.5, 0.55)
}

export function getStatusColor(statusCode: number | null, hasError: boolean): string {
	if (hasError || (statusCode != null && statusCode >= 500)) return "#c45a3c"
	if (statusCode != null && statusCode >= 400) return "#d4a843"
	return "#5cb88a"
}

export function getStatusBgColor(statusCode: number | null, hasError: boolean): string {
	if (hasError || (statusCode != null && statusCode >= 500)) return "rgba(196, 90, 60, 0.2)"
	if (statusCode != null && statusCode >= 400) return "rgba(212, 168, 67, 0.2)"
	return "rgba(92, 184, 138, 0.2)"
}
