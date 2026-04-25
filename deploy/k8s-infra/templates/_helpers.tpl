{{/*
Expand the name of the chart.
*/}}
{{- define "maple-k8s-infra.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "maple-k8s-infra.fullname" -}}
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

{{- define "maple-k8s-infra.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "maple-k8s-infra.labels" -}}
helm.sh/chart: {{ include "maple-k8s-infra.chart" . }}
app.kubernetes.io/name: {{ include "maple-k8s-infra.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "maple-k8s-infra.selectorLabels" -}}
app.kubernetes.io/name: {{ include "maple-k8s-infra.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "maple-k8s-infra.agent.fullname" -}}
{{- printf "%s-agent" (include "maple-k8s-infra.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "maple-k8s-infra.cluster.fullname" -}}
{{- printf "%s-cluster" (include "maple-k8s-infra.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "maple-k8s-infra.agent.selectorLabels" -}}
{{ include "maple-k8s-infra.selectorLabels" . }}
app.kubernetes.io/component: agent
{{- end -}}

{{- define "maple-k8s-infra.cluster.selectorLabels" -}}
{{ include "maple-k8s-infra.selectorLabels" . }}
app.kubernetes.io/component: cluster-collector
{{- end -}}

{{- define "maple-k8s-infra.image" -}}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) -}}
{{- end -}}

{{- define "maple-k8s-infra.ingestSecretName" -}}
{{- if .Values.maple.ingestKey.existingSecret.name -}}
{{- .Values.maple.ingestKey.existingSecret.name -}}
{{- else -}}
{{- printf "%s-ingest-key" (include "maple-k8s-infra.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "maple-k8s-infra.ingestSecretKey" -}}
{{- if .Values.maple.ingestKey.existingSecret.key -}}
{{- .Values.maple.ingestKey.existingSecret.key -}}
{{- else -}}
ingest-key
{{- end -}}
{{- end -}}

{{- define "maple-k8s-infra.agent.serviceAccountName" -}}
{{- if .Values.agent.serviceAccount.create -}}
{{- default (include "maple-k8s-infra.agent.fullname" .) .Values.agent.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.agent.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "maple-k8s-infra.cluster.serviceAccountName" -}}
{{- if .Values.clusterCollector.serviceAccount.create -}}
{{- default (include "maple-k8s-infra.cluster.fullname" .) .Values.clusterCollector.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.clusterCollector.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "maple-k8s-infra.clusterName" -}}
{{- if .Values.global.clusterName -}}
{{- .Values.global.clusterName -}}
{{- else -}}
{{- .Release.Name -}}
{{- end -}}
{{- end -}}

{{/*
Resolve the OTLP HTTP endpoint that user-app pods should send to.
Falls back to the in-cluster agent Service when no override is set.
The agent Service exposes port 4318 (otlp-http) and is gated on
presets.otlpReceiver.http.enabled.
*/}}
{{- define "maple-k8s-infra.autoInstrument.otlpEndpoint" -}}
{{- if .Values.autoInstrumentation.instrumentation.otlpEndpointOverride -}}
{{- .Values.autoInstrumentation.instrumentation.otlpEndpointOverride -}}
{{- else -}}
{{- printf "http://%s.%s.svc.cluster.local:%d" (include "maple-k8s-infra.agent.fullname" .) .Release.Namespace (int .Values.presets.otlpReceiver.http.containerPort) -}}
{{- end -}}
{{- end -}}

{{- define "maple-k8s-infra.autoInstrument.crNamespacedName" -}}
{{- printf "%s/%s" .Release.Namespace .Values.autoInstrumentation.instrumentation.name -}}
{{- end -}}

{{- define "maple-k8s-infra.resourceAttributes.agent" -}}
{{- $attrs := list "maple.collector.role=agent" (printf "k8s.cluster.name=%s" (include "maple-k8s-infra.clusterName" .)) "k8s.node.name=$(K8S_NODE_NAME)" "host.name=$(K8S_NODE_NAME)" -}}
{{- if .Values.global.deploymentEnvironment -}}
{{- $attrs = append $attrs (printf "deployment.environment=%s" .Values.global.deploymentEnvironment) -}}
{{- end -}}
{{- join "," $attrs -}}
{{- end -}}

{{- define "maple-k8s-infra.resourceAttributes.cluster" -}}
{{- $attrs := list "maple.collector.role=cluster" (printf "k8s.cluster.name=%s" (include "maple-k8s-infra.clusterName" .)) -}}
{{- if .Values.global.deploymentEnvironment -}}
{{- $attrs = append $attrs (printf "deployment.environment=%s" .Values.global.deploymentEnvironment) -}}
{{- end -}}
{{- join "," $attrs -}}
{{- end -}}

{{- define "maple-k8s-infra.commonEnv" -}}
- name: MAPLE_INGEST_ENDPOINT
  value: {{ .Values.maple.ingest.endpoint | quote }}
- name: MAPLE_INGEST_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "maple-k8s-infra.ingestSecretName" . }}
      key: {{ include "maple-k8s-infra.ingestSecretKey" . }}
      optional: true
- name: K8S_CLUSTER_NAME
  value: {{ include "maple-k8s-infra.clusterName" . | quote }}
{{- end -}}

{{- define "maple-k8s-infra.k8sEnv" -}}
- name: K8S_NODE_NAME
  valueFrom:
    fieldRef:
      fieldPath: spec.nodeName
- name: K8S_HOST_IP
  valueFrom:
    fieldRef:
      fieldPath: status.hostIP
- name: K8S_POD_NAME
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
- name: K8S_NAMESPACE
  valueFrom:
    fieldRef:
      fieldPath: metadata.namespace
{{- end -}}

{{- define "maple-k8s-infra.agentMetricReceivers" -}}
{{- $receivers := list -}}
{{- if .Values.presets.otlpReceiver.enabled -}}
{{- $receivers = append $receivers "otlp" -}}
{{- end -}}
{{- if .Values.presets.hostMetrics.enabled -}}
{{- $receivers = append $receivers "hostmetrics" -}}
{{- end -}}
{{- if .Values.presets.kubeletMetrics.enabled -}}
{{- $receivers = append $receivers "kubeletstats" -}}
{{- end -}}
{{- printf "[%s]" (join ", " $receivers) -}}
{{- end -}}

{{- define "maple-k8s-infra.agentLogReceivers" -}}
{{- $receivers := list -}}
{{- if .Values.presets.otlpReceiver.enabled -}}
{{- $receivers = append $receivers "otlp" -}}
{{- end -}}
{{- if .Values.presets.podLogs.enabled -}}
{{- $receivers = append $receivers "filelog/k8s" -}}
{{- end -}}
{{- printf "[%s]" (join ", " $receivers) -}}
{{- end -}}

{{- define "maple-k8s-infra.baseProcessors" -}}
{{- $processors := list "memory_limiter" -}}
{{- if .Values.processors.kubernetesAttributes.enabled -}}
{{- $processors = append $processors "k8sattributes" -}}
{{- end -}}
{{- if .Values.processors.resourceDetection.enabled -}}
{{- $processors = append $processors "resourcedetection" -}}
{{- end -}}
{{- $processors = append $processors "batch" -}}
{{- printf "[%s]" (join ", " $processors) -}}
{{- end -}}
