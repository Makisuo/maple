# MCP OAuth

Maple's remote MCP endpoint (`/mcp`) is an OAuth 2.1 protected resource. Clients discover the
Maple authorization server through RFC 9728 protected-resource metadata, register as public
clients, and use authorization code + S256 PKCE.

## Discovery and endpoints

- `GET /.well-known/oauth-protected-resource/mcp`
- `GET /.well-known/oauth-authorization-server`
- `POST /register` — dynamic registration for public clients; redirect URIs must use HTTPS or a
  loopback HTTP address.
- `GET /oauth/authorize` — validates the client, registered redirect URI, `resource`, `mcp:tools`
  scope, and PKCE challenge before redirecting to the Maple approval page. Redirect URIs match
  exactly except that HTTP loopback clients may use a different port at authorization time, as
  required by RFC 8252.
- `POST /oauth/token` — accepts form-encoded `authorization_code` and `refresh_token` grants.
- `POST /oauth/revoke` — revokes an access token or an entire refresh-token family.

Unauthenticated MCP requests return `401` with a `WWW-Authenticate` challenge containing the
protected-resource metadata URL and required `mcp:tools` scope.

## Credentials

Authorization codes are single-use and expire after five minutes. Access tokens are opaque,
hashed Maple MCP keys with a one-hour expiry. Their metadata binds the approving user's roles,
OAuth client, and exact MCP resource. Refresh tokens are opaque, hashed, valid for 30 days, and
rotate on every use. Reusing a rotated refresh token revokes the whole grant family.

Manual MCP keys remain supported for clients without OAuth. They continue to use the existing
`Authorization: Bearer ...` configuration and are isolated to the MCP server by `kind: "mcp"`.

## Browser approval

The API redirects valid authorization requests to `/mcp-authorize` on `MAPLE_APP_BASE_URL`. The
existing sign-in and active-workspace redirects protect this page. Approval captures the current
workspace, user, and roles; changing workspace before approval changes the workspace bound to the
issued grant.

Deploy migration `0018_brown_brood.sql` before enabling the OAuth routes.
