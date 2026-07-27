/**
 * Authority used when addressing the chat-flue Worker over the `CHAT_FLUE`
 * service binding.
 *
 * A service binding routes by binding name, never by DNS, so in production this
 * host is never resolved and any value would work. It matters in local dev: the
 * Worker runs behind `@cloudflare/vite-plugin`, and Vite rejects a request whose
 * `Host` header isn't in `server.allowedHosts` with a bare **403** — which the
 * caller records as `start_rejected`, a non-retryable failure that looks like an
 * auth problem and isn't. Vite always allows `*.localhost`, and that's also the
 * host portless serves chat-flue on, so this one value is correct in both places.
 */
export const CHAT_FLUE_ORIGIN = "https://chat-flue.localhost"
