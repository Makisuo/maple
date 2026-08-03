export const API_CORS_OPTIONS = {
	allowedOrigins: ["*"],
	allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
	allowedHeaders: ["*"],
	// The ElectricSQL shape proxy (and its electric-* exposed headers) moved
	// to the standalone `apps/electric-sync` worker.
	exposedHeaders: ["Mcp-Session-Id", "Retry-After"],
}
