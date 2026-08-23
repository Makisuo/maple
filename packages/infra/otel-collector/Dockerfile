# The OTel collector that runs on ECS Fargate beside the ingest gateway — see
# `apps/ingest/alchemy.run.ts` (context = this directory, so the image is
# rebuilt only when these two files change).
#
# Pinned, not `latest`: the tag is the contrib release whose manifest carries
# the `tinybird` exporter this config needs, and it matches the 0.151.0 pins in
# `otel/builder-config.yaml` and the exporter's go.mod. Bump all three together.
#
# The upstream image is a static binary on `scratch`, running as a nonroot
# uid: no shell, no writable filesystem. That rules out a container health
# check command and a file-backed queue directory, which is why
# collector-config.yaml keeps its queue in memory.
FROM otel/opentelemetry-collector-contrib:0.151.0

COPY collector-config.yaml /etc/otelcol-contrib/config.yaml

# 4318 = OTLP/HTTP (what the gateway posts to), 13133 = health_check.
EXPOSE 4318 13133

CMD ["--config", "/etc/otelcol-contrib/config.yaml"]
