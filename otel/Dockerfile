FROM otel/opentelemetry-collector-contrib:latest

USER 0
RUN mkdir -p /var/lib/otelcol/file_storage && chown -R 10001:10001 /var/lib/otelcol
USER 10001

COPY collector-config.yaml /etc/otelcol/config.yaml

EXPOSE 4317 4318 13133

CMD ["--config", "/etc/otelcol/config.yaml"]
