import { Effect, Schema } from "effect"

const hasHeader = (headers: Readonly<Record<string, string>>, name: string): boolean =>
	Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase())

const isLoopbackHost = (hostname: string): boolean => {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
	return (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host === "::1" ||
		/^127(?:\.\d{1,3}){3}$/.test(host)
	)
}

export const shouldUseCloudflareAccess = (
	baseUrl: string,
	headers: Readonly<Record<string, string>>,
): boolean => {
	let url: URL
	try {
		url = new URL(baseUrl)
	} catch {
		return false
	}
	return (
		url.protocol === "https:" &&
		!isLoopbackHost(url.hostname) &&
		!hasHeader(headers, "cf-access-token") &&
		!hasHeader(headers, "cf-access-client-id")
	)
}

export const isCloudflareAccessResponse = (status: number, location: string | null): boolean => {
	if (status === 401 || status === 403) return true
	if (status < 300 || status >= 400 || location === null) return false
	try {
		const url = new URL(location, "https://maple.invalid")
		return url.hostname.endsWith(".cloudflareaccess.com") || url.pathname.startsWith("/cdn-cgi/access/")
	} catch {
		return false
	}
}

export class CloudflareAccessError extends Schema.TaggedError<CloudflareAccessError>()(
	"@maple/cli/CloudflareAccessError",
	{ message: Schema.String },
) {}

export const cloudflareAccessError = (baseUrl: string): CloudflareAccessError => {
	const origin = new URL(baseUrl).origin
	return new CloudflareAccessError({
		message: `Cloudflare Access denied the local server request. Run \`cloudflared access login ${origin}\`, or set MAPLE_LOCAL_HEADERS with CF-Access-Client-Id and CF-Access-Client-Secret.`,
	})
}

export const withCloudflareAccessToken = (
	baseUrl: string,
	headers: Readonly<Record<string, string>>,
): Effect.Effect<Record<string, string>> => {
	const configured = { ...headers }
	if (!shouldUseCloudflareAccess(baseUrl, configured)) return Effect.succeed(configured)
	const origin = new URL(baseUrl).origin
	return Effect.tryPromise({
		try: async () => {
			const process = Bun.spawn(["cloudflared", "access", "token", `-app=${origin}`], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "ignore",
			})
			const token = (await new Response(process.stdout).text()).trim()
			if ((await process.exited) !== 0 || !token) return configured
			return { ...configured, "cf-access-token": token }
		},
		catch: () => configured,
	}).pipe(Effect.orElseSucceed(() => configured))
}
