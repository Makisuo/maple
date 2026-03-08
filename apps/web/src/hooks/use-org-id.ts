import { getRouteApi } from "@tanstack/react-router"

const rootApi = getRouteApi("__root__")

export function useOrgId(): string {
  const context = rootApi.useRouteContext()
  return context.auth?.orgId ?? ""
}
