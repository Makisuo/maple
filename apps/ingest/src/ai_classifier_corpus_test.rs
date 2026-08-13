//! Corpus replay — the acceptance gate for the classifier.
//!
//! Replays every capture in the trace-capture corpus (raw OTLP/JSON export requests
//! as they arrived on the wire) through the crate's own OTLP/JSON decode path and
//! the classifier, and compares the result against the hand-reviewed goldens in
//! `frameworks/<name>/registry-seed.yaml`.
//!
//! Run it with the corpus checked out next door:
//!
//! ```sh
//! TRACE_CAPTURE_DIR=~/Documents/repos/trace-capture cargo test --lib corpus
//! ```
//!
//! Unset, every test here skips cleanly — the corpus is a sibling repo. CI runs
//! the vendored-fixture twin (`ai_classification_fixture_test.rs`) instead.
//!
//! # How the goldens map onto a multi-vendor registry
//!
//! Each seed's goldens describe ONE vendor's rules and separate *harness*-emitted
//! spans (fixture scaffolding) from the framework's own. The compiled registry has
//! no harness concept and all 21 vendors at once, so the identities checked here
//! are:
//!
//! * **vendor span count** = `vendor_span_counts[<seed vendor>] + harness_matched`.
//!   The two can only diverge if another vendor outranks this one on some span, and
//!   no corpus span is claimed by two vendors — so any divergence is a real finding.
//! * **key-state histogram / unsessioned traces** are the seed's per-vendor view of
//!   *every* span in the capture regardless of which vendor classified it, so they
//!   are reproduced through `evaluate_session_for_vendor`.
//!
//! The `langgraph` → `langchain` fold is applied when looking the vendor up.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;

use crate::ai_classifier::{session_state, ResourceContext};
use crate::ai_registry::registry;
use crate::otlp_json;

/// Seed vendor slug → compiled registry slug.
fn registry_slug(seed_vendor: &str) -> &str {
    match seed_vendor {
        "langgraph" => "langchain",
        other => other,
    }
}

fn corpus_root() -> Option<PathBuf> {
    let root = PathBuf::from(std::env::var_os("TRACE_CAPTURE_DIR")?);
    if root.join("captures").is_dir() && root.join("frameworks").is_dir() {
        Some(root)
    } else {
        panic!("TRACE_CAPTURE_DIR={root:?} has no captures/ and frameworks/");
    }
}

/// One capture's spans, decoded exactly as ingest would decode them.
struct Capture {
    dir: String,
    /// (resource attrs, scope, schema_url, span) grouped as they arrived.
    requests: Vec<ExportTraceServiceRequest>,
}

impl Capture {
    fn load(path: &Path) -> Self {
        let dir = path
            .file_name()
            .expect("capture dir")
            .to_string_lossy()
            .into_owned();
        let records = std::fs::read_to_string(path.join("records.jsonl")).expect("records.jsonl");
        let mut requests = Vec::new();
        for line in records.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let record: serde_json::Value = serde_json::from_str(line).expect("record json");
            if record.get("signal").and_then(|s| s.as_str()) != Some("traces") {
                continue;
            }
            let Some(mut body) = record.get("body").cloned().filter(|b| !b.is_null()) else {
                continue; // undecodable capture record (`rawBase64` only)
            };
            // The crate's own OTLP/JSON leniency pass, then the generated types —
            // the same two steps `decode_and_enrich_payload` runs on the wire.
            otlp_json::normalize(&mut body, "resourceSpans");
            let request: ExportTraceServiceRequest =
                serde_json::from_value(body).expect("OTLP/JSON decodes");
            requests.push(request);
        }
        Capture { dir, requests }
    }

    fn span_count(&self) -> usize {
        self.requests
            .iter()
            .flat_map(|r| &r.resource_spans)
            .flat_map(|rs| &rs.scope_spans)
            .map(|ss| ss.spans.len())
            .sum()
    }
}

/// What one capture produces under the full registry.
#[derive(Default)]
struct CaptureResult {
    /// vendor slug (or `""` for non-AI) → span count
    vendors: BTreeMap<String, usize>,
    /// state (under the *classified* vendor) → span count
    states: BTreeMap<u8, usize>,
    hashes: usize,
}

fn classify_capture(capture: &Capture) -> CaptureResult {
    let registry = registry();
    let mut result = CaptureResult::default();
    for request in &capture.requests {
        for resource_spans in &request.resource_spans {
            let empty = Vec::new();
            let attributes = resource_spans
                .resource
                .as_ref()
                .map(|r| &r.attributes)
                .unwrap_or(&empty);
            let resource_context = ResourceContext::new(registry, attributes);
            for scope_spans in &resource_spans.scope_spans {
                let schema_url = if scope_spans.schema_url.is_empty() {
                    resource_spans.schema_url.as_str()
                } else {
                    scope_spans.schema_url.as_str()
                };
                let scope = resource_context.scope(scope_spans.scope.as_ref(), schema_url);
                for span in &scope_spans.spans {
                    let classified =
                        scope.classify_span_full(&span.name, &span.attributes, &span.events);
                    assert_eq!(classified.rules_version, registry.version());
                    *result
                        .vendors
                        .entry(classified.vendor_slug().to_string())
                        .or_default() += 1;
                    *result.states.entry(classified.session_state).or_default() += 1;
                    if classified.session_state >= session_state::SUB_SESSION {
                        assert_ne!(classified.session_key_hash(), 0);
                        result.hashes += 1;
                    } else {
                        assert_eq!(classified.session_key_hash(), 0);
                    }
                }
            }
        }
    }
    result
}

/// Per-vendor state histogram over EVERY span of the capture — the seed's view.
fn seed_state_view(capture: &Capture, vendor_slug: &str) -> (BTreeMap<u8, usize>, usize) {
    let registry = registry();
    let vendor = registry
        .vendor_id(vendor_slug)
        .unwrap_or_else(|| panic!("registry has no vendor {vendor_slug}"));
    let mut histogram: BTreeMap<u8, usize> = BTreeMap::new();
    // trace id → does any span of it reach state 6
    let mut traces: HashMap<Vec<u8>, bool> = HashMap::new();
    for request in &capture.requests {
        for resource_spans in &request.resource_spans {
            let empty = Vec::new();
            let attributes = resource_spans
                .resource
                .as_ref()
                .map(|r| &r.attributes)
                .unwrap_or(&empty);
            let resource_context = ResourceContext::new(registry, attributes);
            for scope_spans in &resource_spans.scope_spans {
                let schema_url = if scope_spans.schema_url.is_empty() {
                    resource_spans.schema_url.as_str()
                } else {
                    scope_spans.schema_url.as_str()
                };
                let scope = resource_context.scope(scope_spans.scope.as_ref(), schema_url);
                for span in &scope_spans.spans {
                    let (state, _) = scope.evaluate_session_for_vendor(
                        vendor,
                        &span.name,
                        &span.attributes,
                        &span.events,
                    );
                    *histogram.entry(state).or_default() += 1;
                    let sessioned = traces.entry(span.trace_id.clone()).or_insert(false);
                    *sessioned |= state == session_state::SESSION;
                }
            }
        }
    }
    let unsessioned = traces.values().filter(|sessioned| !**sessioned).count();
    (histogram, unsessioned)
}

// ---------------------------------------------------------------------------
// goldens
// ---------------------------------------------------------------------------

struct Golden {
    framework: String,
    vendor: String,
    capture: String,
    total_spans: usize,
    vendor_spans: usize,
    key_state_histogram: BTreeMap<u8, usize>,
    unsessioned_traces: usize,
}

fn number(value: &serde_yaml::Value) -> usize {
    value
        .as_u64()
        .unwrap_or_else(|| panic!("expected a number, got {value:?}")) as usize
}

fn load_goldens(root: &Path) -> Vec<Golden> {
    let mut goldens = Vec::new();
    let mut frameworks: Vec<_> = std::fs::read_dir(root.join("frameworks"))
        .expect("frameworks/")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.join("registry-seed.yaml").is_file())
        .collect();
    frameworks.sort();
    for framework in frameworks {
        let text = std::fs::read_to_string(framework.join("registry-seed.yaml")).expect("seed");
        let seed: serde_yaml::Value = serde_yaml::from_str(&text).expect("seed yaml");
        let seed_vendor = seed["vendor"].as_str().expect("vendor").to_string();
        let per_capture = seed["goldens"]["per_capture"]
            .as_sequence()
            .expect("goldens.per_capture");
        for entry in per_capture {
            let capture = entry["capture"].as_str().expect("capture").to_string();
            let counts = &entry["vendor_span_counts"];
            let vendor_spans =
                number(&counts[seed_vendor.as_str()]) + number(&entry["harness_matched"]);
            let mut histogram = BTreeMap::new();
            for (state, count) in entry["key_state_histogram"]
                .as_mapping()
                .expect("key_state_histogram")
            {
                histogram.insert(number(state) as u8, number(count));
            }
            goldens.push(Golden {
                framework: framework
                    .file_name()
                    .expect("framework")
                    .to_string_lossy()
                    .into_owned(),
                vendor: registry_slug(&seed_vendor).to_string(),
                capture,
                total_spans: number(&entry["total_spans"]),
                vendor_spans,
                key_state_histogram: histogram,
                unsessioned_traces: number(&entry["unsessioned_traces"]),
            });
        }
    }
    goldens
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

/// The gate: every golden in all 20 seeds reproduces.
#[test]
fn corpus_replay_matches_every_golden() {
    let Some(root) = corpus_root() else {
        eprintln!("skipping: set TRACE_CAPTURE_DIR to the trace-capture checkout");
        return;
    };
    let goldens = load_goldens(&root);
    assert!(goldens.len() >= 40, "expected the full seed set");

    let mut cache: HashMap<String, (Capture, CaptureResult)> = HashMap::new();
    let mut failures = Vec::new();
    println!(
        "{:<34} {:<26} {:>7} {:>7} {:>6}",
        "capture", "vendor", "spans", "golden", "ok"
    );
    for golden in &goldens {
        let entry = cache.entry(golden.capture.clone()).or_insert_with(|| {
            let capture = Capture::load(&root.join("captures").join(&golden.capture));
            let result = classify_capture(&capture);
            (capture, result)
        });
        let (capture, result) = entry;

        let mut problems = Vec::new();
        if capture.span_count() != golden.total_spans {
            problems.push(format!(
                "span count {} != golden {}",
                capture.span_count(),
                golden.total_spans
            ));
        }
        let classified = result.vendors.get(&golden.vendor).copied().unwrap_or(0);
        if classified != golden.vendor_spans {
            problems.push(format!(
                "vendor spans {classified} != golden {} (all vendors: {:?})",
                golden.vendor_spans, result.vendors
            ));
        }
        let (histogram, unsessioned) = seed_state_view(capture, &golden.vendor);
        if histogram != golden.key_state_histogram {
            problems.push(format!(
                "key_state_histogram {histogram:?} != golden {:?}",
                golden.key_state_histogram
            ));
        }
        if unsessioned != golden.unsessioned_traces {
            problems.push(format!(
                "unsessioned traces {unsessioned} != golden {}",
                golden.unsessioned_traces
            ));
        }

        println!(
            "{:<34} {:<26} {:>7} {:>7} {:>6}",
            golden.capture,
            golden.vendor,
            classified,
            golden.vendor_spans,
            if problems.is_empty() { "PASS" } else { "FAIL" }
        );
        if !problems.is_empty() {
            failures.push(format!(
                "{}/{}: {}",
                golden.framework,
                golden.capture,
                problems.join("; ")
            ));
        }
    }
    let total_spans: usize = cache.values().map(|(c, _)| c.span_count()).sum();
    println!(
        "\n{} goldens over {} captures, {total_spans} spans",
        goldens.len(),
        cache.len()
    );
    assert!(
        failures.is_empty(),
        "golden mismatches:\n{}",
        failures.join("\n")
    );
}

/// Every capture in the corpus — including the ones no seed claims (probes, smoke
/// tests, the two large `eve_slack` negative sets) — must decode and classify
/// without panicking, and every examined span must carry the rules version.
#[test]
fn corpus_replay_never_panics_and_always_stamps_the_version() {
    let Some(root) = corpus_root() else {
        eprintln!("skipping: set TRACE_CAPTURE_DIR to the trace-capture checkout");
        return;
    };
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(root.join("captures"))
        .expect("captures/")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.join("records.jsonl").is_file())
        .collect();
    dirs.sort();
    assert!(dirs.len() >= 40, "expected the full corpus");

    let mut totals: BTreeMap<String, usize> = BTreeMap::new();
    let mut spans = 0usize;
    for dir in &dirs {
        let capture = Capture::load(dir);
        let result = classify_capture(&capture);
        spans += capture.span_count();
        println!("{:<34} {:?}", capture.dir, result.vendors);
        for (vendor, count) in result.vendors {
            *totals.entry(vendor).or_default() += count;
        }
    }
    println!(
        "\n{} captures, {spans} spans\ncorpus totals: {totals:?}",
        dirs.len()
    );
    let non_ai = totals.get("").copied().unwrap_or(0);
    assert!(
        spans > 0 && non_ai > 0,
        "corpus must contain both AI and non-AI spans"
    );
}

/// At most one vendor's `detect` fires on any corpus span — the invariant that
/// keeps the `VENDORS` resolution order from being load-bearing on real wire data.
/// Zero overlaps today, so no allowlist: the first corpus span two vendors both
/// claim fails here and forces a deliberate ordering (or rules) decision. The
/// vendored-fixture twin of this test runs on every plain `cargo test`.
#[test]
fn at_most_one_vendor_matches_any_corpus_span() {
    let Some(root) = corpus_root() else {
        eprintln!("skipping: set TRACE_CAPTURE_DIR to the trace-capture checkout");
        return;
    };
    let registry = registry();
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(root.join("captures"))
        .expect("captures/")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.join("records.jsonl").is_file())
        .collect();
    dirs.sort();

    let mut checked = 0usize;
    let mut overlaps = Vec::new();
    for dir in &dirs {
        let capture = Capture::load(dir);
        for request in &capture.requests {
            for resource_spans in &request.resource_spans {
                let empty = Vec::new();
                let attributes = resource_spans
                    .resource
                    .as_ref()
                    .map(|r| &r.attributes)
                    .unwrap_or(&empty);
                let resource_context = ResourceContext::new(registry, attributes);
                for scope_spans in &resource_spans.scope_spans {
                    let scope =
                        resource_context.scope(scope_spans.scope.as_ref(), &scope_spans.schema_url);
                    for span in &scope_spans.spans {
                        let firing =
                            scope.firing_vendors(&span.name, &span.attributes, &span.events);
                        if firing.len() > 1 {
                            overlaps.push(format!(
                                "{}: span {:?} fires {firing:?}",
                                capture.dir, span.name
                            ));
                        }
                        checked += 1;
                    }
                }
            }
        }
    }
    println!("{checked} corpus spans checked for vendor overlap");
    assert!(
        overlaps.is_empty(),
        "vendor detects overlap on corpus spans:\n{}",
        overlaps.join("\n")
    );
}

/// Order independence over real data: shuffling the non-registry attributes of every
/// corpus span must not move a single classification.
#[test]
fn corpus_classification_is_order_independent() {
    let Some(root) = corpus_root() else {
        eprintln!("skipping: set TRACE_CAPTURE_DIR to the trace-capture checkout");
        return;
    };
    let registry = registry();
    let mut checked = 0usize;
    for dir in ["spring_ai_user", "crewai_user", "flue_user", "eve_slack"] {
        let capture = Capture::load(&root.join("captures").join(dir));
        for request in &capture.requests {
            for resource_spans in &request.resource_spans {
                let empty = Vec::new();
                let attributes = resource_spans
                    .resource
                    .as_ref()
                    .map(|r| &r.attributes)
                    .unwrap_or(&empty);
                let context = ResourceContext::new(registry, attributes);
                for scope_spans in &resource_spans.scope_spans {
                    let scope = context.scope(scope_spans.scope.as_ref(), &scope_spans.schema_url);
                    for span in &scope_spans.spans {
                        let straight = scope.classify_span(&span.name, &span.attributes);
                        // Reverse the order of the keys no rule consults; the
                        // registry-referenced ones keep their relative order because
                        // first-occurrence-wins is order-*dependent* by design.
                        let (referenced, rest): (Vec<_>, Vec<_>) = span
                            .attributes
                            .iter()
                            .cloned()
                            .partition(|kv| registry.references_key(&kv.key));
                        let mut shuffled: Vec<_> = rest.into_iter().rev().collect();
                        shuffled.extend(referenced);
                        let reordered = scope.classify_span(&span.name, &shuffled);
                        assert_eq!(
                            straight.vendor, reordered.vendor,
                            "{dir}: {} reordered differently",
                            span.name
                        );
                        assert_eq!(straight.session_state, reordered.session_state);
                        checked += 1;
                    }
                }
            }
        }
    }
    println!("{checked} spans checked for order independence");
}
