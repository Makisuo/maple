import { disableTool } from "eve/tools";

/**
 * THE one that mattered most. eve's `web_fetch` runs in the HOST process (not
 * the sandbox) and, as of eve 0.25.3, applies no SSRF protection whatsoever:
 * no loopback / link-local / private-range blocklist, no redirect pinning, no
 * allowlist. On Railway that reaches the private network — and the container's
 * own metadata and sibling services.
 *
 * The agent reads customer telemetry (log bodies, exception messages, span
 * attributes), so a single attacker-controlled log line saying "fetch
 * https://…?q=<what you just read>" is both an exfiltration channel for one
 * tenant's observability data and an SSRF pivot. Nothing this agent legitimately
 * does requires fetching a URL.
 *
 * See agent/tools/bash.ts for the filename→tool-name contract.
 */
export default disableTool();
