#!/usr/bin/env bash
# Post-deploy check for the on-demand PR ingest preview
# (.github/workflows/deploy-pr-preview.yml): is the in-VPC OTel collector
# running, discoverable by the name the gateway was given, and exporting?
#
# Runs inside the workflow because that is where the deploy account's
# credentials are. Everything here is read-only except a handful of
# unauthenticated POSTs at the preview ALB, made so the gateway has requests to
# trace. Hostnames in the job log are partly masked (GitHub hides `maple` and
# the digit `1`), which is why this prints counts and verdicts, not only names.
#
# Usage: PR_NUMBER=<n> AWS_REGION=us-east-1 scripts/ingest-preview-verify.sh
set -euo pipefail

: "${PR_NUMBER:?PR_NUMBER is required}"
region="${AWS_REGION:-us-east-1}"
cluster="maple-ingest-pr-${PR_NUMBER}"
gateway_service="maple-ingest-pr-${PR_NUMBER}"
collector_service="maple-otel-collector-pr-${PR_NUMBER}"
namespace="maple-ingest-pr-${PR_NUMBER}.internal"
failures=0

fail() {
	echo "::error::$*"
	failures=$((failures + 1))
}

running_count() {
	aws ecs describe-services --region "$region" --cluster "$cluster" --services "$1" \
		--query 'services[0].runningCount' --output text
}

log_group_of() {
	local task_def
	task_def=$(aws ecs describe-services --region "$region" --cluster "$cluster" --services "$1" \
		--query 'services[0].taskDefinition' --output text)
	aws ecs describe-task-definition --region "$region" --task-definition "$task_def" \
		--query 'taskDefinition.containerDefinitions[0].logConfiguration.options."awslogs-group"' --output text
}

echo "== ECS services in $cluster"
for _ in $(seq 1 18); do
	collector_running=$(running_count "$collector_service")
	[ "$collector_running" != "0" ] && [ "$collector_running" != "None" ] && break
	sleep 10
done
echo "collector running tasks: ${collector_running:-?}"
echo "gateway running tasks:   $(running_count "$gateway_service")"
if [ "${collector_running:-0}" = "0" ] || [ "${collector_running:-None}" = "None" ]; then
	fail "collector service has no running task"
fi

echo "== Cloud Map: $namespace / otel-collector"
instances=0
for _ in $(seq 1 12); do
	instances=$(aws servicediscovery discover-instances --region "$region" \
		--namespace-name "$namespace" --service-name otel-collector \
		--query 'length(Instances)' --output text 2>/dev/null || echo 0)
	[ "$instances" != "0" ] && break
	sleep 10
done
echo "registered collector instances: $instances"
if [ "$instances" = "0" ]; then
	fail "no collector instance registered in Cloud Map — the gateway cannot resolve its forward endpoint"
fi

# Give the gateway something to trace: a few unauthenticated OTLP posts land as
# 401s, which the gateway records as spans (4xx is Ok status) and which also
# tick its request metrics. The ALB is found through the gateway's target
# group, since its hostname is generated.
echo "== Exercising the gateway"
tg_arn=$(aws ecs describe-services --region "$region" --cluster "$cluster" --services "$gateway_service" \
	--query 'services[0].loadBalancers[0].targetGroupArn' --output text)
lb_arn=$(aws elbv2 describe-target-groups --region "$region" --target-group-arns "$tg_arn" \
	--query 'TargetGroups[0].LoadBalancerArns[0]' --output text)
alb_dns=$(aws elbv2 describe-load-balancers --region "$region" --load-balancer-arns "$lb_arn" \
	--query 'LoadBalancers[0].DNSName' --output text)
for _ in $(seq 1 5); do
	code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "http://${alb_dns}/v1/traces" \
		-H 'content-type: application/json' -d '{"resourceSpans":[]}' || echo "000")
	echo "POST /v1/traces -> $code"
	sleep 1
done
# Let the gateway's batch exporters flush (30 s metric interval) and the
# collector export.
sleep 75

echo "== Collector log (last 10 minutes)"
collector_logs=$(log_group_of "$collector_service")
aws logs tail "$collector_logs" --region "$region" --since 10m --format short | tail -n 60 || true
collector_export_errors=$(aws logs tail "$collector_logs" --region "$region" --since 10m --format short \
	| grep -c -E 'Exporting failed|Permanent error|error\s' || true)
echo "collector export error lines: $collector_export_errors"
[ "$collector_export_errors" = "0" ] || fail "collector logged export errors"

echo "== Gateway log: OTel exporter lines (last 10 minutes)"
gateway_logs=$(log_group_of "$gateway_service")
gateway_exporter_errors=$(aws logs tail "$gateway_logs" --region "$region" --since 10m --format short \
	| grep -c -i -E 'OpenTelemetry (trace|metrics|logs) error|exporter.*(error|failed)|dns error|connection refused' || true)
echo "gateway exporter error lines: $gateway_exporter_errors"
[ "$gateway_exporter_errors" = "0" ] || fail "gateway logged OTel exporter errors"

# Did anything land? The job carries the stage's Tinybird credentials, so ask
# the warehouse directly for recent `ingest` self-telemetry. An ingest-scoped
# token may lack read access — then this is informational, not a verdict.
if [ -n "${TINYBIRD_HOST:-}" ] && [ -n "${TINYBIRD_TOKEN:-}" ]; then
	echo "== Tinybird: ingest self-telemetry in the last 15 minutes"
	query="SELECT ResourceAttributes['service.instance.id'] AS instance, count() AS spans FROM traces WHERE Timestamp >= now() - INTERVAL 15 MINUTE AND ServiceName = 'ingest' GROUP BY 1 FORMAT JSON"
	response=$(curl -s -m 30 -G "${TINYBIRD_HOST%/}/v0/sql" -H "Authorization: Bearer ${TINYBIRD_TOKEN}" --data-urlencode "q=${query}" || echo '{"error":"request failed"}')
	if printf '%s' "$response" | grep -q '"error"'; then
		echo "query not available with this token: $(printf '%s' "$response" | head -c 300)"
	else
		rows=$(printf '%s' "$response" | grep -o '"rows": *[0-9]*' | grep -o '[0-9]*$' || echo "?")
		echo "ingest instances with spans: $rows"
		printf '%s\n' "$response" | grep -o '"spans": *"\?[0-9]*' | head -n 10 || true
	fi
fi

if [ "$failures" != "0" ]; then
	echo "::error::collector verification failed ($failures check(s))"
	exit 1
fi
echo "collector verification passed"
