export const API_CORS_OPTIONS = {
	allowedOrigins: ["*"],
	allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
	// `Authorization` must be listed EXPLICITLY — the Fetch spec deliberately
	// excludes it from the `*` wildcard. With only `*`, Chrome still lets the
	// request through but refuses to cache its preflight, so every single
	// authenticated call (i.e. all of them) re-preflighted regardless of
	// `maxAge`. Verified in-browser: two identical requests with a plain custom
	// header cost one OPTIONS, the same pair with `Authorization` cost two.
	allowedHeaders: ["*", "Authorization"],
	// The ElectricSQL shape proxy (and its electric-* exposed headers) moved
	// to the standalone `apps/electric-sync` worker.
	exposedHeaders: ["Mcp-Session-Id", "Retry-After"],
	// Every browser call carries an Authorization header, so every one is
	// preflighted. Without this the response has no Access-Control-Max-Age and
	// Chrome falls back to a 5s preflight cache — and since the worker is pinned
	// to us-east-1 (CLOUDFLARE_WORKER_PLACEMENT), each expiry costs a full extra
	// ~165ms round trip from Europe BEFORE the real request is sent. Those
	// preflights are invisible in our own traces because the tracer is disabled
	// for OPTIONS. Browsers clamp this value themselves (Chrome 2h, Firefox 24h).
	maxAge: 86_400,
}
