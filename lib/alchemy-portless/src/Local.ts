// Dev-sidecar entry for `Portless.Route`; mirrors alchemy's own `Command/Local.ts`.
import * as RpcServer from "alchemy/Local/RpcServer"
import { RouteProviderLocal } from "./Route.ts"

RouteProviderLocal().pipe(RpcServer.launch)
