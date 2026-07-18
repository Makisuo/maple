import type { ApiKeyKind } from "@maple/domain/http"
import type { V2ApiKeyCreateParams, V2Scope } from "@maple/domain/http/v2"

export interface ApiKeyCreateOptions {
	expiresInSeconds?: number
	scopes?: ReadonlyArray<V2Scope>
}

export const buildApiKeyCreatePayload = (
	name: string,
	description: string,
	kind: ApiKeyKind | undefined,
	options: ApiKeyCreateOptions = {},
): V2ApiKeyCreateParams => {
	const trimmedDescription = description.trim()

	return {
		name: name.trim(),
		...(trimmedDescription.length > 0 ? { description: trimmedDescription } : {}),
		...(kind !== undefined ? { kind } : {}),
		...(options.expiresInSeconds !== undefined ? { expires_in_seconds: options.expiresInSeconds } : {}),
		...(kind !== "mcp" && options.scopes !== undefined && options.scopes.length > 0
			? { scopes: options.scopes }
			: {}),
	}
}
