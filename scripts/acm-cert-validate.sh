#!/usr/bin/env bash
# Validate each ACM certificate named on the command line by creating its DNS
# validation CNAME in the Cloudflare zone, then wait until ACM reports ISSUED.
#
#   bash scripts/acm-cert-validate.sh ingest.maple.dev electric.maple.dev
#
# Why this exists: the AWS stacks request DNS-validated ACM certificates but
# deliberately do not manage the Cloudflare zone, so the first deploy of a stage
# fails at the 443 listener ("certificate must have a fully-qualified domain
# name…" = still PENDING_VALIDATION). alchemy's own output snapshots
# DomainValidationOptions before ACM fills them in, and GitHub masks digits in
# the log, so "print it and add it by hand" was not workable either. The deploy
# workflows run this after a failed deploy and then retry the deploy once.
#
# EVERY service with its own certificate has to be listed by the caller. A
# domain missing here is a stage that cannot complete its first deploy without
# someone doing this by hand.
#
# Needs: aws cli with the deploy role, CLOUDFLARE_API_TOKEN (Infisical), and
# optional AWS_REGION (default us-east-1). Idempotent: an ISSUED certificate or
# an existing record is a no-op.
set -euo pipefail

if [ "$#" -eq 0 ]; then
    echo "::error::usage: acm-cert-validate.sh <domain> [domain...]"
    exit 1
fi
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
region="${AWS_REGION:-us-east-1}"

cf() { curl -sS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json" "$@"; }
# Fail loudly with Cloudflare's own error list (the token's DNS permission on the
# zone is the usual culprit) instead of a bare non-zero from `jq -e`.
cf_ok() {
    local response; response=$(cat)
    if ! jq -e '.success' >/dev/null <<<"$response"; then
        echo "::error::Cloudflare API call failed: $(jq -c '.errors' <<<"$response")"
        # Name the token so the right one gets the permission (id + status only;
        # GitHub masks digits, so also print the id with separators between
        # characters, which survives the masker).
        local verify; verify=$(cf "https://api.cloudflare.com/client/v4/user/tokens/verify")
        local token_id; token_id=$(jq -r '.result.id // "unknown"' <<<"$verify")
        echo "token in use: id=${token_id} status=$(jq -r '.result.status // "unknown"' <<<"$verify") (id spaced: $(sed 's/./& /g' <<<"$token_id"))"
        return 1
    fi
}

validate_certificate() {
    local domain="$1"
    local zone_name="${domain#*.}"   # ingest.maple.dev -> maple.dev ; electric-staging.maple.dev -> maple.dev
    # All `local`: without it, a domain whose validation record never appears
    # would fall through to the PREVIOUS domain's and publish the wrong CNAME.
    local arn status record_name record_value zones_response zone_id existing

    arn=$(aws acm list-certificates --region "$region" \
        --query "CertificateSummaryList[?DomainName=='${domain}'].CertificateArn | [0]" --output text)
    if [ -z "$arn" ] || [ "$arn" = "None" ]; then
        echo "no ACM certificate for ${domain} in ${region} — nothing to validate"
        return 0
    fi

    status=$(aws acm describe-certificate --region "$region" --certificate-arn "$arn" --query 'Certificate.Status' --output text)
    echo "certificate for ${domain}: ${status}"
    if [ "$status" = "ISSUED" ]; then
        return 0
    fi
    if [ "$status" != "PENDING_VALIDATION" ]; then
        echo "::error::certificate for ${domain} is ${status}; not something a DNS record fixes"
        return 1
    fi

    # ACM fills the validation options a few seconds after CreateCertificate.
    for _ in $(seq 1 30); do
        record_name=$(aws acm describe-certificate --region "$region" --certificate-arn "$arn" \
            --query 'Certificate.DomainValidationOptions[0].ResourceRecord.Name' --output text)
        record_value=$(aws acm describe-certificate --region "$region" --certificate-arn "$arn" \
            --query 'Certificate.DomainValidationOptions[0].ResourceRecord.Value' --output text)
        [ -n "$record_name" ] && [ "$record_name" != "None" ] && break
        sleep 5
    done
    if [ -z "${record_name:-}" ] || [ "$record_name" = "None" ]; then
        echo "::error::ACM never returned a validation record for ${arn}"
        return 1
    fi
    record_name="${record_name%.}"
    record_value="${record_value%.}"

    zones_response=$(cf "https://api.cloudflare.com/client/v4/zones?name=${zone_name}&status=active")
    zone_id=$(jq -r '.result[0].id // empty' <<<"$zones_response")
    if [ -z "$zone_id" ]; then
        echo "::error::Cloudflare zone ${zone_name} not visible to CLOUDFLARE_API_TOKEN: $(jq -c '{success, errors}' <<<"$zones_response")"
        return 1
    fi

    existing=$(cf "https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records?type=CNAME&name=${record_name}" | jq -r '.result[0].id // empty')
    if [ -n "$existing" ]; then
        echo "validation CNAME already present (record ${existing}); updating content in case it rotated"
        cf -X PATCH "https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records/${existing}" \
            --data "$(jq -nc --arg c "$record_value" '{content:$c, ttl:1, proxied:false}')" | cf_ok
    else
        echo "creating validation CNAME for ${domain} in zone ${zone_name}"
        cf -X POST "https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records" \
            --data "$(jq -nc --arg n "$record_name" --arg c "$record_value" '{type:"CNAME", name:$n, content:$c, ttl:1, proxied:false, comment:"ACM validation (managed by deploy workflow)"}')" | cf_ok
    fi

    # ACM usually picks up a Cloudflare-hosted record within a few minutes. The
    # built-in waiter gives up after 5 attempts; loop it to about 20 minutes.
    for _ in $(seq 1 4); do
        if aws acm wait certificate-validated --region "$region" --certificate-arn "$arn"; then
            echo "certificate for ${domain}: ISSUED"
            return 0
        fi
    done
    echo "::error::certificate for ${domain} still not ISSUED after ~20 minutes — check the validation CNAME in Cloudflare"
    return 1
}

for domain in "$@"; do
    validate_certificate "$domain"
done
