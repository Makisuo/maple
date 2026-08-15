import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { AuthApiGroup, AuthPublicApiGroup } from "./auth"
import { BillingPublicApiGroup } from "./billing"
import { SharePublicApiGroup } from "./share"
import { ErrorsApiGroup } from "./errors"
import { IntegrationsApiGroup } from "./integrations"
import { OrgClickHouseSettingsApiGroup } from "./org-clickhouse-settings"
import { OrganizationsApiGroup } from "./organizations"
import { SessionReplaysApiGroup } from "./session-replay"
import { V1SchemaErrors, V1UnexpectedErrors } from "./v1-boundary"
export class MapleApi extends HttpApi.make("MapleApi")
	.add(AuthPublicApiGroup)
	.add(AuthApiGroup)
	.add(BillingPublicApiGroup)
	.add(SharePublicApiGroup)
	.add(ErrorsApiGroup)
	.add(IntegrationsApiGroup)
	.add(OrgClickHouseSettingsApiGroup)
	.add(OrganizationsApiGroup)
	.add(SessionReplaysApiGroup)
	.middleware(V1SchemaErrors)
	.middleware(V1UnexpectedErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Maple API",
			version: "1.0.0",
			description: "Effect-based backend API for Maple.",
		}),
	) {}
