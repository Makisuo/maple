import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { AiTriageApiGroup } from "./ai-triage"
import { AnomaliesApiGroup } from "./anomalies"
import { AuthApiGroup, AuthPublicApiGroup } from "./auth"
import { BillingApiGroup, BillingPublicApiGroup } from "./billing"
import { ChatApiGroup } from "./chat"
import { DashboardsApiGroup } from "./dashboards"
import { DemoApiGroup } from "./demo"
import { DigestApiGroup } from "./digest"
import { ErrorsApiGroup } from "./errors"
import { IntegrationsApiGroup } from "./integrations"
import { ObservabilityApiGroup } from "./observability"
import { OnboardingApiGroup } from "./onboarding"
import { OrgClickHouseSettingsApiGroup } from "./org-clickhouse-settings"
import { OrganizationsApiGroup } from "./organizations"
import { SessionReplaysApiGroup } from "./session-replay"
import { WarehouseApiGroup } from "./warehouse"
import { V1SchemaErrors, V1UnexpectedErrors } from "./v1-boundary"
export class MapleApi extends HttpApi.make("MapleApi")
	.add(AuthPublicApiGroup)
	.add(AuthApiGroup)
	.add(AiTriageApiGroup)
	.add(AnomaliesApiGroup)
	.add(BillingApiGroup)
	.add(BillingPublicApiGroup)
	.add(ChatApiGroup)
	.add(DashboardsApiGroup)
	.add(DemoApiGroup)
	.add(DigestApiGroup)
	.add(ErrorsApiGroup)
	.add(IntegrationsApiGroup)
	.add(ObservabilityApiGroup)
	.add(OnboardingApiGroup)
	.add(OrgClickHouseSettingsApiGroup)
	.add(OrganizationsApiGroup)
	.add(SessionReplaysApiGroup)
	.add(WarehouseApiGroup)
	.middleware(V1SchemaErrors)
	.middleware(V1UnexpectedErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Maple API",
			version: "1.0.0",
			description: "Effect-based backend API for Maple.",
		}),
	) {}
