import { timingSafeEqual } from "node:crypto"
import { ManagedRuntime, Effect, Layer } from "effect"
import type { TenantContext as McpTenantContext } from "@/lib/tenant-context"
import { AuthService } from "@/services/AuthService"
import { ApiKeysService } from "@/services/ApiKeysService"
import { Env } from "@/services/Env"
import { API_KEY_PREFIX } from "@maple/db"

const INTERNAL_SERVICE_PREFIX = "maple_svc_"

const EnvRuntime = ManagedRuntime.make(Env.Default)
const ApiKeyResolutionRuntime = ManagedRuntime.make(
  ApiKeysService.Live.pipe(Layer.provide(Env.Default)),
)
const AuthRuntime = ManagedRuntime.make(AuthService.Default)

const toHeaderRecord = (headers: Headers): Record<string, string> => {
  const record: Record<string, string> = {}

  for (const [name, value] of headers.entries()) {
    record[name] = value
  }

  return record
}

const getBearerToken = (headers: Headers): string | undefined => {
  const header = headers.get("authorization")
  if (!header) return undefined
  const [scheme, token] = header.split(" ")
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") return undefined
  return token
}

export async function resolveMcpTenantContext(request: Request): Promise<McpTenantContext> {
  const token = getBearerToken(request.headers)

  // Internal service auth (e.g. chat agent)
  if (token && token.startsWith(INTERNAL_SERVICE_PREFIX)) {
    const provided = token.slice(INTERNAL_SERVICE_PREFIX.length)
    const env = await EnvRuntime.runPromise(Env)
    const expected = env.INTERNAL_SERVICE_TOKEN

    if (
      expected.length > 0 &&
      provided.length === expected.length &&
      timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
    ) {
      const orgId = env.MAPLE_ORG_ID_OVERRIDE.length > 0
        ? env.MAPLE_ORG_ID_OVERRIDE
        : request.headers.get("x-org-id")
      if (!orgId) {
        throw new Error("X-Org-Id header is required for internal service auth")
      }

      return {
        orgId,
        userId: "internal-service",
        roles: [],
        authMode: "self_hosted",
      }
    }

    throw new Error("Invalid internal service token")
  }

  if (token && token.startsWith(API_KEY_PREFIX)) {
    const resolved = await ApiKeyResolutionRuntime.runPromise(
      ApiKeysService.resolveByKey(token),
    )

    if (resolved) {
      // Touch lastUsedAt in the background — fire and forget
      void ApiKeyResolutionRuntime.runPromise(
        ApiKeysService.touchLastUsed(resolved.keyId).pipe(Effect.ignore),
      )

      return {
        orgId: resolved.orgId,
        userId: resolved.userId,
        roles: [],
        authMode: "self_hosted",
      }
    }
  }

  // Fall back to existing Clerk / self-hosted session auth
  const tenant = await AuthRuntime.runPromise(
    AuthService.resolveMcpTenant(toHeaderRecord(request.headers)),
  )

  return {
    orgId: tenant.orgId,
    userId: tenant.userId,
    roles: [...tenant.roles],
    authMode: tenant.authMode,
  }
}
