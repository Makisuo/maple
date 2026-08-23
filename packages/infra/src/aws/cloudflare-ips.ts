/**
 * Cloudflare's published proxy egress ranges — the only sources that should be
 * able to reach the ingest ALB once `ingest.<domain>` is proxied. The gateway
 * trusts `Cf-IPCountry` (`MAPLE_INGEST_TRUST_PROXY_GEO`) and leans on
 * Cloudflare for TLS termination and rate limiting, so a directly dialable ALB
 * would let anyone spoof the former and skip the latter.
 *
 * Snapshot of https://www.cloudflare.com/ips-v4 and /ips-v6 taken 2026-08-23.
 * Cloudflare changes these rarely and announces it; to refresh, re-run:
 *
 *   curl -s https://www.cloudflare.com/ips-v4 ; curl -s https://www.cloudflare.com/ips-v6
 *
 * and replace the lists (the test asserts every entry is a well-formed CIDR).
 * Deliberately a checked-in snapshot rather than a fetch at deploy time: a
 * transient fetch failure must not be able to empty the allow-list and cut
 * production ingest off.
 */
export const CLOUDFLARE_IPV4_RANGES: readonly string[] = [
	"173.245.48.0/20",
	"103.21.244.0/22",
	"103.22.200.0/22",
	"103.31.4.0/22",
	"141.101.64.0/18",
	"108.162.192.0/18",
	"190.93.240.0/20",
	"188.114.96.0/20",
	"197.234.240.0/22",
	"198.41.128.0/17",
	"162.158.0.0/15",
	"104.16.0.0/13",
	"104.24.0.0/14",
	"172.64.0.0/13",
	"131.0.72.0/22",
]

export const CLOUDFLARE_IPV6_RANGES: readonly string[] = [
	"2400:cb00::/32",
	"2606:4700::/32",
	"2803:f800::/32",
	"2405:b500::/32",
	"2405:8100::/32",
	"2a06:98c0::/29",
	"2c0f:f248::/32",
]
