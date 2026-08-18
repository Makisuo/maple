import {
	ActorId,
	AlertDeliveryEventId,
	AlertDestinationId,
	AlertIncidentId,
	AlertRuleId,
	AnomalyIncidentId,
	ErrorIncidentId,
	ErrorIssueId,
	InvestigationId,
	MobileDeviceId,
} from "../../primitives"
import { PublicId, PublicIdPrefixes } from "./public-id"

/** Canonical shared public-ID codecs for resources referenced across v2 groups. */
export const AlertRulePublicId = PublicId(PublicIdPrefixes.alertRule, AlertRuleId)
export const AlertDestinationPublicId = PublicId(PublicIdPrefixes.alertDestination, AlertDestinationId)
export const AlertIncidentPublicId = PublicId(PublicIdPrefixes.alertIncident, AlertIncidentId)
export const AlertDeliveryEventPublicId = PublicId(PublicIdPrefixes.event, AlertDeliveryEventId)
export const ActorPublicId = PublicId(PublicIdPrefixes.actor, ActorId)
export const AnomalyIncidentPublicId = PublicId(PublicIdPrefixes.anomalyIncident, AnomalyIncidentId)
export const ErrorIncidentPublicId = PublicId(PublicIdPrefixes.errorIncident, ErrorIncidentId)
export const ErrorIssuePublicId = PublicId(PublicIdPrefixes.errorIssue, ErrorIssueId)
export const InvestigationPublicId = PublicId(PublicIdPrefixes.investigation, InvestigationId)
export const MobileDevicePublicId = PublicId(PublicIdPrefixes.mobileDevice, MobileDeviceId)
