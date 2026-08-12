/** Sample props for the local preview renders (`bun run --cwd packages/email preview`). */
import type { AlertNotificationProps } from "./alert-notification"
import type { WeeklyDigestProps } from "./weekly-digest-core"

/** A healthy week: traffic up, errors down, one service running slightly hot. */
export const healthyDigestProps: WeeklyDigestProps = {
	orgName: "Acme Corp",
	dateRange: { start: "Mar 24", end: "Mar 31" },
	summary: {
		requests: { value: 1_234_567, delta: 12.3 },
		errors: { value: 4231, delta: -8.2 },
		p95Latency: { valueMs: 245, delta: 5.1 },
		dataVolume: { valueBytes: 18_300_000_000, delta: 3.4 },
	},
	series: [
		{ label: "M", requests: 150_000, errors: 400 },
		{ label: "T", requests: 182_000, errors: 520 },
		{ label: "W", requests: 168_000, errors: 610 },
		{ label: "T", requests: 201_000, errors: 480 },
		{ label: "F", requests: 224_000, errors: 690 },
		{ label: "S", requests: 142_000, errors: 380 },
		{ label: "S", requests: 167_000, errors: 751 },
	],
	services: [
		{ name: "api-gateway", requests: 450_000, errorRate: 0.3, p95Ms: 120, requestsDelta: 8.4 },
		{ name: "auth-service", requests: 280_000, errorRate: 1.2, p95Ms: 85, requestsDelta: -3.1 },
		{ name: "payments", requests: 95_000, errorRate: 0.1, p95Ms: 340, requestsDelta: 22.7 },
		{ name: "user-service", requests: 82_000, errorRate: 0.4, p95Ms: 92, requestsDelta: 1.2 },
		{ name: "notification-svc", requests: 45_000, errorRate: 2.8, p95Ms: 210, requestsDelta: -14.0 },
	],
	topErrors: [
		{
			message: "NullPointerException in UserService.getProfile",
			count: 1204,
			affectedServices: 3,
			isNew: false,
		},
		{
			message: "ConnectionTimeout: Redis pool exhausted after 30s",
			count: 892,
			affectedServices: 2,
			isNew: true,
		},
		{ message: "AuthTokenExpired: JWT validation failed", count: 445, affectedServices: 1, isNew: false },
	],
	ingestion: {
		logs: 5_200_000,
		traces: 1_234_567,
		metrics: 890_000,
		totalBytes: 18_300_000_000,
	},
	baseUrl: "https://app.maple.dev",
	dashboardUrl: "https://app.maple.dev",
	unsubscribeUrl: "https://app.maple.dev/settings/notifications",
}

/** Elevated error rate, errors and latency climbing week over week. */
export const watchDigestProps: WeeklyDigestProps = {
	...healthyDigestProps,
	summary: {
		...healthyDigestProps.summary,
		requests: { value: 980_000, delta: -4.1 },
		errors: { value: 21_400, delta: 38.6 },
		p95Latency: { valueMs: 410, delta: 28.9 },
	},
	series: healthyDigestProps.series.map((point, index) => ({
		...point,
		errors: Math.round(point.requests * (0.012 + index * 0.004)),
	})),
	services: [
		{ name: "payments", requests: 120_000, errorRate: 3.4, p95Ms: 520, requestsDelta: -2.1 },
		{ name: "api-gateway", requests: 410_000, errorRate: 1.8, p95Ms: 180, requestsDelta: -6.4 },
		{ name: "auth-service", requests: 240_000, errorRate: 1.1, p95Ms: 130, requestsDelta: 3.2 },
		{ name: "user-service", requests: 78_000, errorRate: 0.5, p95Ms: 96, requestsDelta: 0.4 },
	],
}

/** A service on fire. */
export const criticalDigestProps: WeeklyDigestProps = {
	...healthyDigestProps,
	summary: {
		...healthyDigestProps.summary,
		requests: { value: 760_000, delta: -18.2 },
		errors: { value: 61_800, delta: 142.0 },
		p95Latency: { valueMs: 980, delta: 96.3 },
		dataVolume: { valueBytes: 12_100_000_000, delta: -22.0 },
	},
	series: healthyDigestProps.series.map((point, index) => ({
		...point,
		errors: Math.round(point.requests * (0.03 + index * 0.012)),
	})),
	services: [
		{ name: "payments", requests: 88_000, errorRate: 14.6, p95Ms: 2100, requestsDelta: -41.0 },
		{ name: "checkout", requests: 64_000, errorRate: 8.2, p95Ms: 1450, requestsDelta: -33.5 },
		{ name: "api-gateway", requests: 380_000, errorRate: 4.1, p95Ms: 320, requestsDelta: -12.0 },
		{ name: "auth-service", requests: 210_000, errorRate: 2.0, p95Ms: 240, requestsDelta: -5.1 },
	],
	topErrors: [
		{
			message: "PaymentGatewayTimeout: upstream did not respond within 5000ms",
			count: 18_420,
			affectedServices: 4,
			isNew: true,
		},
		{
			message: "DeadlockDetected: serialization failure on orders table",
			count: 9310,
			affectedServices: 2,
			isNew: true,
		},
		{
			message: "NullPointerException in UserService.getProfile",
			count: 1204,
			affectedServices: 3,
			isNew: false,
		},
	],
}

/** Critical trigger. */
export const alertNotificationProps: AlertNotificationProps = {
	ruleName: "API error rate — checkout",
	eventLabel: "Triggered",
	eventEmoji: "\u{1F6A8}",
	severity: "critical",
	signalLabel: "Error Rate",
	group: "checkout-service",
	observedSummary: "5.2% > 1%",
	window: "5m",
	accentColor: "#e01e5a",
	linkUrl: "https://app.maple.dev/alerts/rule_123",
	chatUrl: "https://app.maple.dev/alerts/incidents/inc_456",
}
