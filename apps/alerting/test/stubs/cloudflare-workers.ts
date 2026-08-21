/** Minimal bindings needed to acquire the alerting production layer in Node. */
export const env: Record<string, unknown> = {
	TINYBIRD_HOST: "https://api.tinybird.co",
	TINYBIRD_TOKEN: "test-token",
	MAPLE_ROOT_PASSWORD: "test-password",
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "test-hmac-key",
} satisfies Record<string, unknown>
