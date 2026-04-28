/// <reference types="@types/bun" />
import { render } from "@react-email/components"
import { WeeklyDigest } from "./weekly-digest"

const html = await render(
	WeeklyDigest({
		orgName: "Acme Corp",
		dateRange: { start: "Mar 24", end: "Mar 31" },
		summary: {
			requests: { value: 1_234_567, delta: 12.3 },
			errors: { value: 4231, delta: -8.2 },
			p95Latency: { valueMs: 245, delta: 5.1 },
			dataVolume: { valueBytes: 18_300_000_000, delta: 3.4 },
		},
		services: [
			{ name: "api-gateway", requests: 450_000, errorRate: 0.3, p95Ms: 120 },
			{ name: "auth-service", requests: 280_000, errorRate: 1.2, p95Ms: 85 },
			{ name: "payments", requests: 95_000, errorRate: 0.1, p95Ms: 340 },
			{ name: "user-service", requests: 82_000, errorRate: 0.4, p95Ms: 92 },
			{ name: "notification-svc", requests: 45_000, errorRate: 6.8, p95Ms: 210 },
		],
		topErrors: [
			{ message: "NullPointerException in UserService.getProfile", count: 1204 },
			{ message: "ConnectionTimeout: Redis pool exhausted after 30s", count: 892 },
			{ message: "AuthTokenExpired: JWT validation failed", count: 445 },
		],
		ingestion: {
			logs: 5_200_000,
			traces: 1_234_567,
			metrics: 890_000,
			totalBytes: 18_300_000_000,
		},
		dashboardUrl: "https://app.maple.dev",
		unsubscribeUrl: "https://app.maple.dev/settings/notifications",
	}),
)

const path = "/tmp/maple-digest-preview.html"
await Bun.write(path, html)
console.log(`Rendered ${html.length} chars -> ${path}`)
