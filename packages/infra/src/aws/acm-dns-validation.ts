/**
 * DNS validation for ACM certificates whose zone lives in Cloudflare.
 *
 * alchemy's `AWS.ACM.Certificate` validates itself only when it is given a
 * Route53 `hostedZoneId` (`Certificate.ts`, `shouldAutoValidate`). Maple's zone
 * is `maple.dev` on Cloudflare, so the certificate lands PENDING_VALIDATION and
 * the ALB's 443 listener then refuses it — the first deploy of any new
 * certificate-bearing domain fails. That gap used to be filled out of band by
 * `scripts/acm-cert-validate.sh` (curl + jq against both APIs, run after a
 * failed deploy, followed by a retry of the deploy).
 *
 * These two resources close it inside the stack, as a chain:
 *
 *   1. `AcmValidationRecord` — describes the certificate until ACM has filled
 *      in the CNAME it wants, and returns it.
 *   2. `Cloudflare.DNS.Record` — publishes that CNAME (the caller's job; it is
 *      a stock alchemy resource).
 *   3. `AcmCertificateIssued` — waits for ACM to observe the record and mark
 *      the certificate ISSUED, and re-emits the ARN so the listener can depend
 *      on the *issued* certificate rather than the requested one.
 *
 * Step 3 is a separate resource rather than part of step 1 because the wait has
 * to happen AFTER the record exists, and an alchemy resource orders itself by
 * the Outputs it consumes: it takes the record's id, so it cannot run early.
 *
 * Both are read-only against AWS — they create nothing and delete nothing, so
 * teardown is a no-op and re-running them is free.
 */
import * as acm from "@distilled.cloud/aws/acm"
import * as AwsRegion from "@distilled.cloud/aws/Region"
import * as Cloudflare from "alchemy/Cloudflare"
import type { Input } from "alchemy/Input"
import * as Provider from "alchemy/Provider"
import { Resource } from "alchemy/Resource"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { requiredPlain } from "../env.ts"
import type { AwsRegionName } from "./stage.ts"

/**
 * ACM fills `ResourceRecord` in asynchronously, seconds after the request. The
 * bound matches alchemy's own internal wait (`waitForValidationRecords`): 2s
 * apart, 60 attempts.
 */
const RECORD_POLL = Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(60)])

/**
 * Issuance follows the DNS record's propagation, which is Cloudflare-fast but
 * not instant, and ACM's own re-check interval is coarser than its record
 * publication. 5s apart for 5 minutes.
 */
const ISSUED_POLL = Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(60)])

export class AcmValidationError extends Schema.TaggedError<AcmValidationError>()("Maple.AcmValidationError", {
	certificateArn: Schema.String,
	message: Schema.String,
}) {}

export interface AcmValidationRecordProps {
	/** The certificate to read. Accepts the `certificateArn` Output of an `AWS.ACM.Certificate`. */
	certificateArn: string
	/** The region the certificate was requested in. */
	region: AwsRegionName
}

export interface AcmValidationRecordAttributes {
	certificateArn: string
	/** Fully-qualified record name ACM wants, trailing dot stripped. */
	recordName: string
	/** The CNAME target. */
	recordValue: string
}

export type AcmValidationRecord = Resource<
	"Maple.AcmValidationRecord",
	AcmValidationRecordProps,
	AcmValidationRecordAttributes
>

export const AcmValidationRecord = Resource<AcmValidationRecord>("Maple.AcmValidationRecord")

export interface AcmCertificateIssuedProps {
	certificateArn: string
	/** The region the certificate was requested in. */
	region: AwsRegionName
	/**
	 * Anything that must exist first — in practice the published
	 * `Cloudflare.DNS.Record`'s id. Consuming it is what orders this resource
	 * after the record; the value itself is never read.
	 */
	after: string
}

export interface AcmCertificateIssuedAttributes {
	certificateArn: string
	status: string
}

export type AcmCertificateIssued = Resource<
	"Maple.AcmCertificateIssued",
	AcmCertificateIssuedProps,
	AcmCertificateIssuedAttributes
>

export const AcmCertificateIssued = Resource<AcmCertificateIssued>("Maple.AcmCertificateIssued")

/**
 * A certificate lives in one region and must be described there — an ALB can
 * only use a certificate from its own region, so this is the same region the
 * `AWS.ACM.Certificate` was requested in, and the caller passes it rather than
 * parsing it back out of the ARN.
 */
const describe = (certificateArn: string, region: AwsRegionName) =>
	acm.describeCertificate({ CertificateArn: certificateArn }).pipe(
		Effect.map((response) => response.Certificate),
		// A per-call region override, not application wiring: `Region`'s service
		// value is an `Effect<RegionName>`, so it is provided as an effect.
		Effect.provideService(AwsRegion.Region, Effect.succeed(region)),
	)

/** ACM returns validation record names fully qualified with a trailing dot; DNS APIs do not want it. */
const stripTrailingDot = (name: string): string => name.replace(/\.$/, "")

export const AcmValidationRecordProvider = () =>
	Provider.succeed(AcmValidationRecord, {
		stables: ["certificateArn"],
		// Read-only: there is no such thing as listing "validation reads".
		list: () => Effect.succeed([]),
		delete: () => Effect.void,
		reconcile: Effect.fn(function* ({ news }) {
			const found = yield* describe(news.certificateArn, news.region).pipe(
				Effect.flatMap((detail) => {
					const record = detail?.DomainValidationOptions?.[0]?.ResourceRecord
					return record?.Name && record.Value
						? Effect.succeed({ name: record.Name, value: record.Value })
						: Effect.fail(
								new AcmValidationError({
									certificateArn: news.certificateArn,
									message: "ACM has not published a DNS validation record yet",
								}),
							)
				}),
				Effect.retry({
					while: (error) => error._tag === "Maple.AcmValidationError",
					schedule: RECORD_POLL,
				}),
			)
			return {
				certificateArn: news.certificateArn,
				recordName: stripTrailingDot(found.name),
				recordValue: found.value,
			} satisfies AcmValidationRecordAttributes
		}),
	})

export const AcmCertificateIssuedProvider = () =>
	Provider.succeed(AcmCertificateIssued, {
		stables: ["certificateArn"],
		list: () => Effect.succeed([]),
		delete: () => Effect.void,
		reconcile: Effect.fn(function* ({ news }) {
			const status = yield* describe(news.certificateArn, news.region).pipe(
				Effect.flatMap((detail) =>
					detail?.Status === "ISSUED"
						? Effect.succeed(detail.Status)
						: Effect.fail(
								new AcmValidationError({
									certificateArn: news.certificateArn,
									message: `certificate is ${detail?.Status ?? "unknown"}, not ISSUED`,
								}),
							),
				),
				Effect.retry({
					while: (error) => error._tag === "Maple.AcmValidationError",
					schedule: ISSUED_POLL,
				}),
			)
			return { certificateArn: news.certificateArn, status } satisfies AcmCertificateIssuedAttributes
		}),
	})

/**
 * Register both providers; merge into the stack's `providers` layer alongside
 * `AWS.providers()`, whose credentials and HTTP client these reads use.
 */
export const providers = () => Layer.mergeAll(AcmValidationRecordProvider(), AcmCertificateIssuedProvider())

/**
 * Issue an ACM certificate whose DNS lives in the Cloudflare zone: publish the
 * validation CNAME, wait for ACM to see it, and hand back the ARN of the
 * ISSUED certificate.
 *
 * Feed the RESULT to the ALB listener rather than `certificate.certificateArn`.
 * Both are the same string, but consuming this one is what makes the listener
 * wait for issuance — attaching the requested certificate is the failure this
 * whole module exists to remove ("certificate must have a fully-qualified
 * domain name…", which is ACM's way of saying PENDING_VALIDATION).
 *
 * The zone is resolved by name from the hostname, so this stack reads the
 * Cloudflare zone but never manages it — the zone itself stays outside alchemy.
 */
export const issueCertificateViaCloudflare = Effect.fn(function* ({
	id,
	certificateArn,
	hostname,
	region,
}: {
	/** Logical id prefix for the three resources this creates. */
	id: string
	/** Accepts an `AWS.ACM.Certificate`'s `certificateArn` Output. */
	certificateArn: Input<string>
	/** The name on the certificate, e.g. `ingest.maple.dev`; also selects the zone. */
	hostname: string
	region: AwsRegionName
}) {
	const accountId = yield* requiredPlain("CLOUDFLARE_ACCOUNT_ID")
	// A certificate-bearing domain whose zone this account cannot see is a
	// misconfigured stack, not a runtime condition — there is nothing to fall
	// back to, and the deploy would otherwise fail later and less clearly.
	const zoneId = yield* Cloudflare.Zone.resolveZoneId({
		accountId,
		zone: undefined,
		hostname,
	}).pipe(
		Effect.catch((cause: Error) =>
			// oxlint-disable-next-line maple/no-effect-die -- stack wiring invariant, see above
			Effect.die(
				new AcmValidationError({
					certificateArn: hostname,
					message: `no Cloudflare zone for ${hostname}: ${cause.message}`,
				}),
			),
		),
	)

	const validation = yield* AcmValidationRecord(`${id}-validation`, {
		certificateArn,
		region,
	})

	// Never proxied: this record is read by ACM's validator, not by browsers,
	// and Cloudflare's proxy would answer with its own edge address instead of
	// the CNAME target. TTL 60 so a re-issued certificate's record converges
	// quickly; ACM reuses the same record across renewals.
	const record = yield* Cloudflare.DNS.Record(`${id}-validation-record`, {
		zoneId,
		type: "CNAME",
		name: validation.recordName,
		content: validation.recordValue,
		proxied: false,
		ttl: 60,
	})

	const issued = yield* AcmCertificateIssued(`${id}-issued`, {
		certificateArn,
		region,
		after: record.recordId,
	})

	return issued.certificateArn
})
