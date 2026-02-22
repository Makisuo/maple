/**
 * Parse a redirect URL string (e.g. `/traces?status=error&page=2`)
 * into `{ pathname, search }` compatible with TanStack Router's Navigate API.
 */
export function parseRedirectUrl(url: string): {
  pathname: string
  search: Record<string, string>
} {
  const qIndex = url.indexOf("?")
  if (qIndex === -1) {
    return { pathname: url, search: {} }
  }

  const pathname = url.slice(0, qIndex)
  const search: Record<string, string> = {}
  const params = new URLSearchParams(url.slice(qIndex))
  for (const [key, value] of params) {
    search[key] = value
  }
  return { pathname, search }
}
