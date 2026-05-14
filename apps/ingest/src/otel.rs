use opentelemetry::KeyValue;
use opentelemetry_sdk::Resource;
use std::env;
use tracing::field::Empty;
use tracing::{info_span, Span};

pub struct ResourceConfig {
    pub service_name: &'static str,
    pub service_version: &'static str,
    pub service_instance_id: String,
    pub deployment_env: String,
    pub internal_org_id: String,
}

pub fn build_resource(cfg: ResourceConfig) -> Resource {
    let mut attrs = vec![
        KeyValue::new("service.name", cfg.service_name),
        KeyValue::new("service.version", cfg.service_version),
        KeyValue::new("service.instance.id", cfg.service_instance_id),
        KeyValue::new("deployment.environment.name", cfg.deployment_env.clone()),
        // Dual-emit the legacy `deployment.environment` key — every Tinybird MV
        // (service_overview_spans_mv, service_map_*_mv, error_*_mv,
        // logs_aggregates_hourly_mv, service_platforms_hourly_mv) still pre-extracts
        // ResourceAttributes['deployment.environment'] at write time. Drop only
        // after those MVs migrate to coalesce() both keys.
        KeyValue::new("deployment.environment", cfg.deployment_env),
        KeyValue::new("process.runtime.name", "rust"),
        KeyValue::new("process.runtime.version", rustc_version()),
        KeyValue::new("os.type", os_type()),
        KeyValue::new("host.arch", host_arch()),
        KeyValue::new("maple.sdk.type", "server"),
        KeyValue::new("maple_org_id", cfg.internal_org_id),
    ];
    attrs.extend(detect_platform());
    Resource::builder().with_attributes(attrs).build()
}

/// Mirrors lib/effect-sdk/src/server/platform.ts platform detection — first
/// match wins. Returns the cloud.{provider,platform,region} (and faas.* / k8s.*
/// where applicable) attribute set for the runtime environment.
fn detect_platform() -> Vec<KeyValue> {
    if env::var("CF_VERSION_METADATA").is_ok() || env::var("WORKERS_CI").is_ok() {
        return vec![
            KeyValue::new("cloud.provider", "cloudflare"),
            KeyValue::new("cloud.platform", "cloudflare.workers"),
        ];
    }
    if let Ok(fn_name) = env::var("AWS_LAMBDA_FUNCTION_NAME") {
        let mut attrs = vec![
            KeyValue::new("cloud.provider", "aws"),
            KeyValue::new("cloud.platform", "aws_lambda"),
            KeyValue::new("faas.name", fn_name),
        ];
        if let Ok(region) = env::var("AWS_REGION") {
            attrs.push(KeyValue::new("cloud.region", region));
        }
        if let Ok(version) = env::var("AWS_LAMBDA_FUNCTION_VERSION") {
            attrs.push(KeyValue::new("faas.version", version));
        }
        if let Ok(instance) = env::var("AWS_LAMBDA_LOG_STREAM_NAME") {
            attrs.push(KeyValue::new("faas.instance", instance));
        }
        return attrs;
    }
    if env::var("RAILWAY_ENVIRONMENT_NAME").is_ok() {
        let mut attrs = vec![
            KeyValue::new("cloud.provider", "railway"),
            KeyValue::new("cloud.platform", "railway"),
        ];
        if let Ok(replica) = env::var("RAILWAY_REPLICA_ID") {
            attrs.push(KeyValue::new("faas.instance", replica));
        }
        if let Ok(region) = env::var("RAILWAY_REPLICA_REGION") {
            attrs.push(KeyValue::new("cloud.region", region));
        }
        return attrs;
    }
    if env::var("VERCEL").is_ok() {
        let mut attrs = vec![
            KeyValue::new("cloud.provider", "vercel"),
            KeyValue::new("cloud.platform", "vercel"),
        ];
        if let Ok(region) = env::var("VERCEL_REGION") {
            attrs.push(KeyValue::new("cloud.region", region));
        }
        if let Ok(deployment) = env::var("VERCEL_DEPLOYMENT_ID") {
            attrs.push(KeyValue::new("faas.instance", deployment));
        }
        return attrs;
    }
    if let Ok(service) = env::var("K_SERVICE") {
        let mut attrs = vec![
            KeyValue::new("cloud.provider", "gcp"),
            KeyValue::new("cloud.platform", "gcp_cloud_run"),
            KeyValue::new("faas.name", service),
        ];
        if let Ok(revision) = env::var("K_REVISION") {
            attrs.push(KeyValue::new("faas.version", revision));
        }
        if let Ok(region) = env::var("CLOUD_RUN_REGION") {
            attrs.push(KeyValue::new("cloud.region", region));
        }
        return attrs;
    }
    if env::var("RENDER").is_ok() {
        let mut attrs = vec![
            KeyValue::new("cloud.provider", "render"),
            KeyValue::new("cloud.platform", "render"),
        ];
        if let Ok(instance) = env::var("RENDER_INSTANCE_ID") {
            attrs.push(KeyValue::new("faas.instance", instance));
        }
        return attrs;
    }
    if let Ok(app) = env::var("FLY_APP_NAME") {
        let mut attrs = vec![
            KeyValue::new("cloud.provider", "fly"),
            KeyValue::new("cloud.platform", "fly"),
            KeyValue::new("faas.name", app),
        ];
        if let Ok(region) = env::var("FLY_REGION") {
            attrs.push(KeyValue::new("cloud.region", region));
        }
        if let Ok(machine) = env::var("FLY_MACHINE_ID") {
            attrs.push(KeyValue::new("faas.instance", machine));
        }
        return attrs;
    }
    if env::var("KUBERNETES_SERVICE_HOST").is_ok() {
        let mut attrs = vec![KeyValue::new("cloud.platform", "k8s")];
        if let Ok(cluster) = env::var("K8S_CLUSTER_NAME") {
            attrs.push(KeyValue::new("k8s.cluster.name", cluster));
        }
        if let Ok(pod) = env::var("K8S_POD_NAME") {
            attrs.push(KeyValue::new("k8s.pod.name", pod));
        }
        if let Ok(deployment) = env::var("K8S_DEPLOYMENT_NAME") {
            attrs.push(KeyValue::new("k8s.deployment.name", deployment));
        }
        return attrs;
    }
    Vec::new()
}

fn os_type() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "windows",
        other => other,
    }
}

fn host_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "x86" => "x86",
        "aarch64" => "arm64",
        other => other,
    }
}

fn rustc_version() -> &'static str {
    option_env!("CARGO_PKG_RUST_VERSION").unwrap_or("unknown")
}

/// Downstream-forward client-kind span. `peer_service` is the canonical name of
/// the destination service as it appears in the service map (see
/// `.agents/skills/maple-telemetry-conventions/rules/service-map-attribution.md`
/// for the registry). `url.full` and `server.address` are recorded later inside
/// `forward_to_collector` because the URL is computed there.
pub fn forward_client_span(
    peer_service: &'static str,
    body_size: usize,
    signal_path: &'static str,
) -> Span {
    info_span!(
        "forward",
        otel.name = "POST",
        otel.kind = "client",
        otel.status_code = Empty,
        "peer.service" = peer_service,
        "http.request.method" = "POST",
        "http.request.body.size" = body_size,
        "http.response.status_code" = Empty,
        "url.full" = Empty,
        "server.address" = Empty,
        "error.type" = Empty,
        "maple.signal" = signal_path,
        "maple.ingest.upstream_pool" = Empty,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find_attr<'a>(resource: &'a Resource, key: &str) -> Option<String> {
        resource
            .iter()
            .find(|(k, _)| k.as_str() == key)
            .map(|(_, v)| v.to_string())
    }

    #[test]
    fn build_resource_sets_runtime_and_sdk_type() {
        let resource = build_resource(ResourceConfig {
            service_name: "ingest",
            service_version: "0.0.0",
            service_instance_id: "test-instance".to_string(),
            deployment_env: "test".to_string(),
            internal_org_id: "internal".to_string(),
        });
        assert_eq!(
            find_attr(&resource, "process.runtime.name").as_deref(),
            Some("rust")
        );
        assert_eq!(
            find_attr(&resource, "maple.sdk.type").as_deref(),
            Some("server")
        );
        assert_eq!(
            find_attr(&resource, "service.name").as_deref(),
            Some("ingest")
        );
        // Dual-emit deployment env
        assert_eq!(
            find_attr(&resource, "deployment.environment.name").as_deref(),
            Some("test")
        );
        assert_eq!(
            find_attr(&resource, "deployment.environment").as_deref(),
            Some("test")
        );
    }
}
