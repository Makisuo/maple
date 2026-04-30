{{- define "maple-otel.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "maple-otel.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "maple-otel.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "maple-otel.labels" -}}
helm.sh/chart: {{ include "maple-otel.chart" . }}
app.kubernetes.io/name: {{ include "maple-otel.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: collector
{{- end -}}

{{- define "maple-otel.selectorLabels" -}}
app.kubernetes.io/name: {{ include "maple-otel.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "maple-otel.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "maple-otel.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Resolve the image reference. `image.tag` falls back to .Chart.AppVersion so
the chart's appVersion bump rolls the image automatically.
*/}}
{{- define "maple-otel.image" -}}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) -}}
{{- end -}}

{{/*
Name of the Secret holding the ClickHouse password. Either the user-
supplied existingSecret or a chart-managed one.
*/}}
{{- define "maple-otel.clickhouseSecretName" -}}
{{- if .Values.maple.clickhouse.password.existingSecret.name -}}
{{- .Values.maple.clickhouse.password.existingSecret.name -}}
{{- else -}}
{{- printf "%s-clickhouse-password" (include "maple-otel.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "maple-otel.clickhouseSecretKey" -}}
{{- if .Values.maple.clickhouse.password.existingSecret.key -}}
{{- .Values.maple.clickhouse.password.existingSecret.key -}}
{{- else -}}
password
{{- end -}}
{{- end -}}

{{/*
Comma-separated list of OTLP protocol blocks for the collector config.
*/}}
{{- define "maple-otel.otlpReceivers" -}}
{{- if .Values.otlp.grpc.enabled -}}
grpc:
            endpoint: 0.0.0.0:{{ .Values.otlp.grpc.port }}
{{- end }}
{{- if .Values.otlp.http.enabled }}
{{- if .Values.otlp.grpc.enabled }}
{{ "" }}
{{- end -}}
http:
            endpoint: 0.0.0.0:{{ .Values.otlp.http.port }}
{{- end }}
{{- end -}}

{{- define "maple-otel.tlsSecretName" -}}
{{- printf "%s-tls" (include "maple-otel.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "maple-otel.issuerName" -}}
{{- printf "%s-letsencrypt-http01" (include "maple-otel.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
