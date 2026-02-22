export interface TenantContext {
  orgId: string
  userId: string
  roles: string[]
  authMode: "clerk" | "self_hosted"
}
