import { Schema } from "effect"
import type { ProductEventInput } from "./ProductEventsService"

/**
 * Clerk webhook payload → product event. Only `user.created` is mapped today
 * (`signup_completed`); everything else is acknowledged and ignored. The
 * schema is deliberately loose — Clerk adds fields freely and a decode failure
 * here would 400 a delivery we would otherwise have handled.
 *
 * No raw email leaves this module: `email_domain` is the only address-derived
 * attribute, and it is enough to separate consumer from company signups.
 */

const ClerkEmailAddress = Schema.Struct({
	id: Schema.optionalKey(Schema.String),
	email_address: Schema.optionalKey(Schema.String),
})

const ClerkExternalAccount = Schema.Struct({
	provider: Schema.optionalKey(Schema.String),
})

export const ClerkUserCreatedData = Schema.Struct({
	id: Schema.String,
	email_addresses: Schema.optionalKey(Schema.Array(ClerkEmailAddress)),
	primary_email_address_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
	external_accounts: Schema.optionalKey(Schema.Array(ClerkExternalAccount)),
	/** Epoch ms. */
	created_at: Schema.optionalKey(Schema.Number),
})

export const ClerkWebhookEnvelope = Schema.Struct({
	type: Schema.String,
	data: Schema.Unknown,
	/** Epoch ms of the event (Clerk stamps this on every delivery). */
	timestamp: Schema.optionalKey(Schema.Number),
})
export type ClerkWebhookEnvelope = Schema.Schema.Type<typeof ClerkWebhookEnvelope>

export const decodeClerkEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(ClerkWebhookEnvelope))
export const decodeClerkUserCreated = Schema.decodeUnknownEffect(ClerkUserCreatedData)
type ClerkUserCreatedData = Schema.Schema.Type<typeof ClerkUserCreatedData>

const emailDomain = (data: ClerkUserCreatedData): string | undefined => {
	const addresses = data.email_addresses ?? []
	const primary =
		addresses.find((entry) => entry.id !== undefined && entry.id === data.primary_email_address_id) ??
		addresses[0]
	const at = primary?.email_address?.lastIndexOf("@") ?? -1
	if (primary?.email_address === undefined || at < 0) return undefined
	const domain = primary.email_address
		.slice(at + 1)
		.trim()
		.toLowerCase()
	return domain.length > 0 ? domain : undefined
}

/** `oauth_google` → `google`; no external account → `email`. */
const signUpSource = (data: ClerkUserCreatedData): string => {
	const provider = data.external_accounts?.find((entry) => entry.provider !== undefined)?.provider
	if (provider === undefined || provider.length === 0) return "email"
	return provider.startsWith("oauth_") ? provider.slice("oauth_".length) : provider
}

export const signupCompletedEvent = (
	data: ClerkUserCreatedData,
	envelopeTimestamp: number | undefined,
): ProductEventInput => {
	const domain = emailDomain(data)
	return {
		name: "signup_completed",
		userId: data.id,
		timestamp: data.created_at ?? envelopeTimestamp,
		attributes: {
			sign_up_source: signUpSource(data),
			...(domain !== undefined ? { email_domain: domain } : undefined),
		},
	}
}
