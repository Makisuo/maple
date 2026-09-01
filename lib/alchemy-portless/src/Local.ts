// The dev sidecar entry for `Portless.Route`: alchemy spawns this module once
// per `alchemy dev` session and routes the provider's lifecycle calls to it,
// so the registered routes (and their removal finalizers) outlive stack-file
// hot reloads. Mirrors alchemy's own `Command/Local.ts`.
import * as RpcServer from "alchemy/Local/RpcServer"
import { RouteProviderLocal } from "./Route.ts"

RouteProviderLocal().pipe(RpcServer.launch)
