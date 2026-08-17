//! Vendored-fixture replay — the CI acceptance gate for the classifier.
//!
//! Replays `fixtures/classification/` (the pruned corpus vendored from
//! trace-capture, see its README) through the classifier's real entry points and
//! asserts two things:
//!
//! 1. every span classifies exactly as `expectations.json` records — vendor,
//!    session-key state and session key, span by span;
//! 2. at most one vendor's `detect` fires on any span.
//!
//! Each fixture line is one span's classifier inputs in OTLP/JSON typed
//! encoding. Lines are rehydrated into a synthetic `ExportTraceServiceRequest`
//! and decoded through `otlp_json::normalize` + the generated types — the same
//! two steps ingest runs on the wire — so typed-value handling is exercised,
//! not reimplemented.
//!
//! Span events ride along and are fed through `classify_span_full` — llamaindex's
//! session key rides a `workflow.output` event attribute, so this is load-bearing.
//! Link *contents* were never captured and the classifier exposes no link
//! accessor, so the fixture's `links_count` field is currently unread.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::KeyValue;
use opentelemetry_proto::tonic::trace::v1::Span;
use sha2::{Digest, Sha256};

use crate::ai_classifier::{session_state, ResourceContext, SpanClassification};
use crate::ai_registry::registry;
use crate::otlp_json;

const FIXTURE_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/classification");

/// Set to regenerate `expectations.json` from the current classifier output
/// instead of asserting against it. Review the resulting diff — it IS the
/// behavior change.
const UPDATE_ENV: &str = "UPDATE_CLASSIFICATION_EXPECTATIONS";

fn fixture_bytes(name: &str) -> Vec<u8> {
    std::fs::read(format!("{FIXTURE_DIR}/{name}"))
        .unwrap_or_else(|e| panic!("read {FIXTURE_DIR}/{name}: {e}"))
}

fn fixture_json(name: &str) -> serde_json::Value {
    serde_json::from_slice(&fixture_bytes(name)).unwrap_or_else(|e| panic!("parse {name}: {e}"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn number(value: &serde_json::Value) -> usize {
    value
        .as_u64()
        .unwrap_or_else(|| panic!("expected a number, got {value:?}")) as usize
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

/// One fixture line, decoded exactly as ingest would decode it off the wire.
struct FixtureSpan {
    capture: String,
    /// A single-span request: `resource_spans[0].scope_spans[0].spans[0]`.
    request: ExportTraceServiceRequest,
}

impl FixtureSpan {
    fn resource_attrs(&self) -> &[KeyValue] {
        self.request.resource_spans[0]
            .resource
            .as_ref()
            .map(|r| r.attributes.as_slice())
            .unwrap_or(&[])
    }

    fn span(&self) -> &Span {
        &self.request.resource_spans[0].scope_spans[0].spans[0]
    }

    /// Hoist resource+scope, classify the span — the row writer's exact shape,
    /// events included.
    fn classify(&self) -> SpanClassification<'_> {
        let scope_spans = &self.request.resource_spans[0].scope_spans[0];
        let resource = ResourceContext::new(registry(), self.resource_attrs());
        let scope = resource.scope(scope_spans.scope.as_ref(), &scope_spans.schema_url);
        let span = self.span();
        scope.classify_span_full(&span.name, &span.attributes, &span.events)
    }
}

/// Rehydrate one JSONL line into a one-span OTLP/JSON request and decode it
/// through the crate's own wire path (`normalize` + the generated types).
///
/// The `expect` below is a whole-gate tripwire, not a per-line one: `serde_json`
/// refuses an unpaired surrogate escape, so one bad line panics the fixture
/// loader and every test that reads it. The generator prevents that — it
/// truncates oversized values on UTF-16 code units and drops a trailing lone
/// high surrogate. If this ever fires on a fresh fixture, fix the truncation
/// upstream in trace-capture's `scripts/generate-classification-fixture.ts`,
/// not here.
fn decode_line(line: &str) -> FixtureSpan {
    let record: serde_json::Value = serde_json::from_str(line).expect("fixture line json");
    let capture = record["capture"].as_str().expect("capture").to_string();

    let events: Vec<serde_json::Value> = record["events"]
        .as_array()
        .expect("events")
        .iter()
        .map(|event| {
            serde_json::json!({
                "name": event["name"],
                "attributes": event["attrs"],
            })
        })
        .collect();
    let mut body = serde_json::json!({
        "resourceSpans": [{
            "resource": { "attributes": record["resource_attrs"] },
            "scopeSpans": [{
                "scope": {
                    "name": record["scope_name"],
                    "version": record["scope_version"],
                },
                "schemaUrl": record["scope_schema_url"],
                "spans": [{
                    "name": record["span_name"],
                    "attributes": record["span_attrs"],
                    "events": events,
                }],
            }],
        }],
    });
    otlp_json::normalize(&mut body, "resourceSpans");
    let request: ExportTraceServiceRequest =
        serde_json::from_value(body).expect("fixture line decodes as OTLP/JSON");

    assert_eq!(
        request.resource_spans.len(),
        1,
        "one ResourceSpans per line"
    );
    assert_eq!(request.resource_spans[0].scope_spans.len(), 1);
    assert_eq!(request.resource_spans[0].scope_spans[0].spans.len(), 1);

    FixtureSpan { capture, request }
}

/// The whole fixture, decoded once per test binary.
fn fixture() -> &'static [FixtureSpan] {
    static FIXTURE: OnceLock<Vec<FixtureSpan>> = OnceLock::new();
    FIXTURE.get_or_init(|| {
        let bytes = fixture_bytes("classification-fixture.jsonl");
        let text = std::str::from_utf8(&bytes).expect("fixture is utf-8");
        text.lines()
            .filter(|line| !line.trim().is_empty())
            .map(decode_line)
            .collect()
    })
}

// ---------------------------------------------------------------------------
// integrity — the staleness check
// ---------------------------------------------------------------------------

/// The vendored JSONL must be byte-identical to what trace-capture generated:
/// the recomputed sha256 matches the manifest and the line count agrees. A
/// hand-edited fixture, a partial re-vendor, or a line-ending mangle fails
/// here, loudly. `source.commit` + `dirty: false` are what make the manifest an
/// anchor: checking out that trace-capture commit and running `bun run fixture`
/// reproduces these bytes.
#[test]
fn fixture_matches_the_manifest() {
    let manifest = fixture_json("manifest.json");
    assert_eq!(
        sha256_hex(&fixture_bytes("classification-fixture.jsonl")),
        manifest["fixture"]["sha256"].as_str().expect("sha256"),
        "classification-fixture.jsonl differs from the manifest — re-vendor it and \
         manifest.json together (see fixtures/classification/README.md)"
    );
    assert_eq!(
        fixture().len(),
        number(&manifest["fixture"]["lines"]),
        "line count"
    );

    let commit = manifest["source"]["commit"].as_str().unwrap_or("");
    assert!(
        commit.len() >= 40 && commit.chars().all(|c| c.is_ascii_hexdigit()),
        "manifest.source.commit is {commit:?}; the fixture cannot be traced back to \
         a trace-capture revision"
    );
    assert_eq!(
        manifest["source"]["dirty"],
        serde_json::json!(false),
        "manifest.source.dirty is true: the fixture was generated from an uncommitted \
         trace-capture tree, so `commit` names a revision that cannot re-derive it. \
         Commit there first, regenerate, and re-vendor — do not flip this expectation."
    );
}

// ---------------------------------------------------------------------------
// per-span replay
// ---------------------------------------------------------------------------

/// What one span is expected to produce: `expectations.json` is an array of
/// these, aligned line-for-line with the fixture JSONL.
#[derive(PartialEq, Debug)]
struct Expected {
    vendor: Option<String>,
    session_state: u8,
    session_key: Option<String>,
}

impl Expected {
    fn of(classified: &SpanClassification<'_>) -> Self {
        Expected {
            vendor: classified.vendor.map(|_| classified.vendor_slug().to_string()),
            session_state: classified.session_state,
            session_key: classified.session_key.as_deref().map(str::to_string),
        }
    }
}

/// Every fixture span classifies exactly as recorded — vendor, session state,
/// session key. Set `UPDATE_CLASSIFICATION_EXPECTATIONS=1` to rewrite the file
/// from current output instead; the diff is the behavior change to review.
#[test]
fn fixture_replay_matches_every_expectation() {
    let reg = registry();
    let produced: Vec<(usize, &FixtureSpan, Expected)> = fixture()
        .iter()
        .enumerate()
        .map(|(i, line)| {
            let classified = line.classify();
            assert_eq!(classified.rules_version, reg.version());
            let expected = Expected::of(&classified);
            (i + 1, line, expected)
        })
        .collect();

    if std::env::var_os(UPDATE_ENV).is_some() {
        let entries: Vec<String> = produced
            .iter()
            .map(|(_, line, out)| {
                serde_json::to_string(&serde_json::json!({
                    "capture": line.capture,
                    "span_name": line.span().name,
                    "vendor": out.vendor,
                    "session_state": out.session_state,
                    "session_key": out.session_key,
                }))
                .expect("expectation entry")
            })
            .collect();
        let body = format!(
            "{{\n  \"format_version\": 2,\n  \"source\": \"snapshot of this crate's \
             classifier over classification-fixture.jsonl; regenerate with \
             {UPDATE_ENV}=1 cargo test --lib fixture_replay, then review the diff\",\n  \
             \"spans\": [\n    {}\n  ]\n}}\n",
            entries.join(",\n    ")
        );
        std::fs::write(format!("{FIXTURE_DIR}/expectations.json"), body)
            .expect("write expectations.json");
        println!("wrote {} expectations", produced.len());
        return;
    }

    let expectations = fixture_json("expectations.json");
    assert_eq!(
        number(&expectations["format_version"]),
        2,
        "expectations.json format_version"
    );
    let spans = expectations["spans"].as_array().expect("spans");
    assert_eq!(
        spans.len(),
        produced.len(),
        "expectations.json is out of step with the fixture — regenerate with \
         {UPDATE_ENV}=1 and review the diff"
    );

    let mut mismatches = Vec::new();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for ((line_no, line, out), entry) in produced.iter().zip(spans) {
        let want = Expected {
            vendor: entry["vendor"].as_str().map(str::to_string),
            session_state: number(&entry["session_state"]) as u8,
            session_key: entry["session_key"].as_str().map(str::to_string),
        };
        *counts
            .entry(out.vendor.clone().unwrap_or_default())
            .or_default() += 1;
        if *out != want {
            mismatches.push(format!(
                "line {line_no} ({} {:?}): got {out:?}, expected {want:?}",
                line.capture,
                line.span().name,
            ));
        }
    }
    println!("per-vendor line counts: {counts:?}");
    assert!(
        mismatches.is_empty(),
        "{} of {} fixture spans diverge from expectations.json — if intentional, \
         regenerate with {UPDATE_ENV}=1 and review the diff:\n{}",
        mismatches.len(),
        produced.len(),
        mismatches[..mismatches.len().min(25)].join("\n")
    );
}

// ---------------------------------------------------------------------------
// indexed vs direct differential
// ---------------------------------------------------------------------------

/// The prefilter/candidate fast path agrees with naive evaluate-every-vendor
/// over every span in the fixture — the internal differential that catches an
/// optimization silently changing semantics, over real data. The direct path
/// reads the **raw, unprefiltered** attribute lists (session state included),
/// so this is also the net for declared-hint drift: a predicate or authority
/// function consulting a key its vendor did not declare diverges here.
#[test]
fn indexed_dispatch_agrees_with_direct_evaluation_over_the_fixture() {
    let mut checked = 0usize;
    for line in fixture() {
        let scope_spans = &line.request.resource_spans[0].scope_spans[0];
        let resource = ResourceContext::new(registry(), line.resource_attrs());
        let scope = resource.scope(scope_spans.scope.as_ref(), &scope_spans.schema_url);
        let span = line.span();

        let indexed = scope.classify_span_full(&span.name, &span.attributes, &span.events);
        let direct = scope.classify_span_unindexed(&span.name, &span.attributes, &span.events);
        assert_eq!(
            indexed.vendor, direct,
            "{}: indexed vs direct disagree on {}",
            line.capture, span.name
        );
        let direct_state = match direct {
            Some(vendor) => {
                scope.evaluate_session_for_vendor_unindexed(
                    vendor,
                    &span.name,
                    &span.attributes,
                    &span.events,
                )
            }
            None => session_state::NOT_EXAMINED,
        };
        assert_eq!(
            indexed.session_state, direct_state,
            "{}: session state diverged on {}",
            line.capture, span.name
        );
        checked += 1;
    }
    println!("{checked} fixture spans checked indexed vs direct");
    assert_eq!(checked, fixture().len());
}

// ---------------------------------------------------------------------------
// at most one vendor matches any span
// ---------------------------------------------------------------------------

/// The resolution rule's supporting invariant: at most one vendor's `detect`
/// fires on any span, so the [`crate::ai_vendors::VENDORS`] slice order is not
/// load-bearing on real wire data. Today the overlap count is exactly **zero**,
/// so there is no allowlist: the first fixture span two vendors both claim
/// fails this test, and a human decides the ordering deliberately (or fixes
/// the rules) rather than shipping an accidental winner.
///
/// The adversarial fixture (`ai_adversarial_fixtures.rs`) is
/// deliberately NOT under this invariant: its `cross_vendor/*` and
/// `oversized/spilled_registry_keys` spans construct multi-vendor evidence to
/// pin the resolution order itself.
#[test]
fn at_most_one_vendor_matches_any_fixture_span() {
    let mut overlaps = Vec::new();
    for line in fixture() {
        let scope_spans = &line.request.resource_spans[0].scope_spans[0];
        let resource = ResourceContext::new(registry(), line.resource_attrs());
        let scope = resource.scope(scope_spans.scope.as_ref(), &scope_spans.schema_url);
        let span = line.span();
        let firing = scope.firing_vendors(&span.name, &span.attributes, &span.events);
        if firing.len() > 1 {
            overlaps.push(format!(
                "{}: span {:?} fires {firing:?}",
                line.capture, span.name
            ));
        }
    }
    assert!(
        overlaps.is_empty(),
        "vendor detects overlap on fixture spans — decide the resolution order \
         deliberately (see VENDORS' doc comment) instead of shipping an accidental \
         winner:\n{}",
        overlaps.join("\n")
    );
}
